#!/usr/bin/env python3
"""Provision a board: Wi-Fi network, device identity, and cloud settings.

    python tools/provision_device.py              do whatever is still missing
    python tools/provision_device.py --wifi       send the Wi-Fi network again
    python tools/provision_device.py --no-wifi    register the board now, add the network later
    python tools/provision_device.py --status     show what the board has
    python tools/provision_device.py --reset      factory reset the board

What it does, in order:

1. Sends the network from ~/.cranium/wifi_secrets.h to the board, which stores it in
   TF-M. The file is read through sudo if it is locked.
2. Asks the board to create its own key pair. The private key never leaves the board;
   the board prints a certificate signing request.
3. Registers the board in AWS IoT: a thing named after the board's hardware ID, a
   certificate issued for that request, the device policy, the device group.
4. Loads the certificate and the Amazon root CA into the board, and tells it which
   AWS IoT endpoint to use and where firmware may be downloaded from.

Needs the AWS CLI with a signed-in profile, and the cloud stack deployed
(cloud/deploy.sh writes cloud/.deploy/outputs.json). Run from an nRF Connect SDK
terminal so that pyserial and cryptography are available.
"""

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from board import BoardError, Console
from local import WIFI_SECRETS

REPO = Path(__file__).resolve().parent.parent
OUTPUTS = REPO / "cloud" / ".deploy" / "outputs.json"
ROOT_CA = REPO / "firmware" / "certs" / "AmazonRootCA1.pem"
# SHA-256 of the DER form of Amazon Root CA 1, as published by Amazon Trust Services.
ROOT_CA_SHA256 = "8ecde6884f3d87b1125ba31ac3fcb13d7016de7f57cc904fe1cb97c6ae98196e"
CHUNK = 300


def fail(message: str) -> None:
    sys.exit(f"error: {message}")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def pem_to_der(pem: str) -> bytes:
    body = re.sub(r"-----(BEGIN|END) [A-Z ]+-----", "", pem)
    return base64.b64decode("".join(body.split()))


class Aws:
    def __init__(self, profile: str, region: str):
        self.base = ["aws", "--profile", profile, "--region", region, "--output", "json",
                     "--no-cli-pager"]

    def call(self, *args: str, allow: tuple[str, ...] = ()) -> dict:
        result = subprocess.run(self.base + list(args), capture_output=True, text=True)
        if result.returncode != 0:
            if any(code in result.stderr for code in allow):
                return {}
            fail(f"aws {' '.join(args[:2])} failed:\n{result.stderr.strip()}")
        return json.loads(result.stdout) if result.stdout.strip() else {}


def read_wifi_secrets() -> tuple[str, str, str]:
    if not WIFI_SECRETS.exists():
        fail(f"{WIFI_SECRETS} does not exist: run `python tools/secrets.py wifi`")
    try:
        text = WIFI_SECRETS.read_text()
    except PermissionError:
        print("The Wi-Fi secrets file is locked; sudo will ask for your password to read it.")
        text = subprocess.run(["sudo", "cat", str(WIFI_SECRETS)], check=True,
                              capture_output=True, text=True).stdout

    def define(name: str, quoted: bool) -> str:
        pattern = rf'^\s*#define\s+{name}\s+' + (r'"((?:[^"\\]|\\.)*)"' if quoted else r"(\w+)")
        match = re.search(pattern, text, re.MULTILINE)
        if not match:
            fail(f"{name} is not defined in the Wi-Fi secrets file")
        value = match.group(1)
        return re.sub(r"\\(.)", r"\1", value) if quoted else value

    ssid = define("WIFI_SECRETS_SSID", True)
    passphrase = define("WIFI_SECRETS_PASSPHRASE", True)
    security = define("WIFI_SECRETS_SECURITY", False)
    if ssid == "your-network-name":
        fail("the Wi-Fi secrets file still contains the placeholder values")
    return ssid, passphrase, security


def provision_wifi(console: Console) -> None:
    ssid, passphrase, security = read_wifi_secrets()
    # Base64 keeps spaces and quotes in the values away from the shell's parser.
    console.run(f"prov wifi {b64(ssid.encode())} {security} {b64(passphrase.encode())}", wait=6)
    print(f"Wi-Fi network \"{ssid}\" ({security}) stored on the board")


def load_certificate(console: Console, der: bytes, kind: str) -> None:
    text = b64(der)
    console.run("prov load begin")
    for offset in range(0, len(text), CHUNK):
        console.run(f"prov load add {text[offset:offset + CHUNK]}")
    console.run(f"prov load commit {kind}", wait=6)


def root_ca_der() -> bytes:
    der = pem_to_der(ROOT_CA.read_text())
    if hashlib.sha256(der).hexdigest() != ROOT_CA_SHA256:
        fail(f"{ROOT_CA.relative_to(REPO)} is not Amazon Root CA 1 (fingerprint mismatch)")
    return der


def request_from_board(console: Console, replace: bool) -> str:
    lines = console.run("prov keygen replace" if replace else "prov keygen", wait=15)
    text = "\n".join(lines)
    match = re.search(r"-----BEGIN CERTIFICATE REQUEST-----.*?-----END CERTIFICATE REQUEST-----",
                      text, re.DOTALL)
    if not match:
        fail("the board did not print a certificate signing request:\n" + text)
    return match.group(0) + "\n"


def register_in_aws(aws: Aws, outputs: dict, thing: str, csr: str) -> bytes:
    aws.call("iot", "create-thing", "--thing-name", thing, allow=("ResourceAlreadyExistsException",))
    aws.call("iot", "add-thing-to-thing-group", "--thing-name", thing,
             "--thing-group-name", outputs["DeviceGroupName"])

    previous = aws.call("iot", "list-thing-principals", "--thing-name", thing).get("principals", [])

    with tempfile.NamedTemporaryFile("w", suffix=".csr") as file:
        file.write(csr)
        file.flush()
        created = aws.call("iot", "create-certificate-from-csr", "--set-as-active",
                           "--certificate-signing-request", f"file://{file.name}")

    arn = created["certificateArn"]
    aws.call("iot", "attach-policy", "--policy-name", outputs["DevicePolicyName"], "--target", arn)
    # Exclusive: AWS IoT refuses to attach this certificate to any other thing.
    aws.call("iot", "attach-thing-principal", "--thing-name", thing, "--principal", arn,
             "--thing-principal-type", "EXCLUSIVE_THING")

    # A board has one identity: retire certificates from earlier provisioning runs.
    for old in previous:
        if old == arn:
            continue
        old_id = old.rsplit("/", 1)[-1]
        aws.call("iot", "detach-thing-principal", "--thing-name", thing, "--principal", old)
        aws.call("iot", "detach-policy", "--policy-name", outputs["DevicePolicyName"],
                 "--target", old, allow=("ResourceNotFoundException", "InvalidRequestException"))
        aws.call("iot", "update-certificate", "--certificate-id", old_id, "--new-status", "INACTIVE")
        aws.call("iot", "delete-certificate", "--certificate-id", old_id,
                 allow=("DeleteConflictException",))
        print(f"Retired the board's previous certificate {old_id[:12]}...")

    print(f"Registered {thing} in AWS IoT with certificate {arn.rsplit('/', 1)[-1][:12]}...")
    return pem_to_der(created["certificatePem"])


def load_outputs() -> dict:
    if not OUTPUTS.exists():
        fail(f"{OUTPUTS.relative_to(REPO)} is missing: deploy the cloud stack first "
             "(cloud/deploy.sh)")
    outputs = json.loads(OUTPUTS.read_text())
    for key in ("Region", "DeviceGroupName", "DevicePolicyName", "FirmwareDownloadPrefix"):
        if key not in outputs:
            fail(f"{OUTPUTS.relative_to(REPO)} has no {key}")
    return outputs


def show(status: dict[str, str]) -> None:
    for key, value in status.items():
        print(f"  {key:<14} {value}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", help="serial port of the board's console (default: auto)")
    parser.add_argument("--profile", default="cranium", help="AWS CLI profile (default: cranium)")
    parser.add_argument("--wifi", action="store_true", help="only (re)send the Wi-Fi network")
    parser.add_argument("--no-wifi", action="store_true",
                        help="skip the Wi-Fi network: identity and cloud settings only")
    parser.add_argument("--status", action="store_true", help="only show the board's state")
    parser.add_argument("--reset", action="store_true", help="factory reset the board")
    parser.add_argument("--new-identity", action="store_true",
                        help="replace the board's key pair and certificate")
    args = parser.parse_args()

    try:
        with Console(args.port) as console:
            status = console.status()
            thing = status["thing name"]
            print(f"Board {thing} on {console.port}, firmware {status.get('firmware', '?')}")

            if args.status:
                show(status)
                return

            if args.reset:
                console.run("prov reset", wait=4, quiet=True)
                print("Board erased and restarted. Its AWS IoT certificate is still "
                      "registered; provisioning again replaces it.")
                return

            has_network = not status.get("wifi network", "").startswith("missing")
            if args.wifi or (not has_network and not args.no_wifi):
                provision_wifi(console)
                has_network = True
                if args.wifi:
                    return

            outputs = load_outputs()
            aws = Aws(args.profile, outputs["Region"])

            needs_identity = (args.new_identity or status.get("private key") != "stored"
                              or status.get("certificate") != "stored")
            if needs_identity:
                # A key without its certificate cannot be reused: the request is only
                # printed when the key is created.
                replace = status.get("private key") == "stored"
                csr = request_from_board(console, replace)
                certificate = register_in_aws(aws, outputs, thing, csr)
                load_certificate(console, certificate, "cert")
                print("Device certificate stored on the board")

            if needs_identity or status.get("root CA") != "stored":
                load_certificate(console, root_ca_der(), "ca")
                print("Amazon Root CA 1 stored on the board")

            endpoint = aws.call("iot", "describe-endpoint", "--endpoint-type",
                                "iot:Data-ATS")["endpointAddress"]
            console.run(f"prov cloud {endpoint} {outputs['FirmwareDownloadPrefix']}", wait=5)
            print("Cloud settings stored on the board")

            if not has_network:
                print("The board is registered and has its certificate. It connects once it "
                      "has a network:\n  python tools/secrets.py wifi\n"
                      "  python tools/provision_device.py --wifi")
                return

            print("Waiting for the board to connect ...")
            deadline = time.time() + 90
            while time.time() < deadline:
                status = console.status()
                if status.get("cloud") == "connected":
                    break
                time.sleep(5)
            show(status)
            if status.get("cloud") != "connected":
                fail("the board is provisioned but has not connected yet; check the Wi-Fi "
                     "network and watch the console")
            print("Done: the board is connected to AWS IoT.")
    except BoardError as error:
        fail(str(error))


if __name__ == "__main__":
    main()
