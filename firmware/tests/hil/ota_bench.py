#!/usr/bin/env python3
"""Hardware-in-the-loop tests of firmware updates: a real board and the deployed cloud.

    python3 firmware/tests/hil/ota_bench.py status
    python3 firmware/tests/hil/ota_bench.py update IMAGE [IMAGE ...]    install one after the other
    python3 firmware/tests/hil/ota_bench.py SCENARIO IMAGE

Scenarios, each with the outcome it insists on:

    decline        Button 2 on an offer: rejected, nothing downloaded
    cancel-offer   the offer is cancelled before any button: board back to idle
    cancel-stop    cancelled with force in mid-download: nothing installed
    older          a job for a version that is not newer: rejected as not_newer
    corrupt        one flipped byte in the download: failed as digest_mismatch
    bad-signature  the image signed with another key: the bootloader refuses it
    faulty         IMAGE misbehaves on trial: the bootloader brings the old image back
    reset-download a reset in mid-download: job failed as interrupted, old image runs
    reset-swap     a reset while the bootloader swaps: the swap finishes, update succeeds
    recovery       IMAGE over the bootloader's serial recovery; a badly signed one is refused

By default a release goes through the deployed console API (--via api): the API function
is invoked directly as the release manager named by --as, so upload validation, the release
list, the audit log and the job come from the code that serves the console. Scenarios
that need what the console rightly refuses create the job themselves. Their ids start with
"cranium-bench-": the download role only serves jobs named cranium-*, and the console
lists only its own format, so they stay out of its deployment list.

"Pressing" a button uses the console's BUTTON command, which takes the path of the real
button. Everything both serial ports print goes to --out, with time stamps. A scenario
ends with PASS or FAIL and appends one line to results.jsonl there.

The board may also run firmware from before the console, with a Zephyr shell on the port:
tools/board.py speaks that as well, so that an update from it to this firmware can be run
and followed from start to finish.

Needs the AWS CLI with a signed-in profile (AWS_PROFILE, default cranium), the board on
USB, and an nRF Connect SDK terminal for pyserial, imgtool and nrfutil.
"""

import argparse
import base64
import collections
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import serial  # noqa: E402
from board import BoardError, Console, find_console_port  # noqa: E402
from serial.tools import list_ports  # noqa: E402

OUTPUTS = REPO / "cloud" / ".deploy" / "outputs.json"
FINISHED = {"SUCCEEDED", "FAILED", "REJECTED", "REMOVED", "CANCELED", "TIMED_OUT"}
URL_EXPIRES_SEC = 600
JOB_TIMEOUT_MIN = 30


class TestFailed(RuntimeError):
    pass


def note(text: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {text}", flush=True)


class LoggedPort:
    """A serial port read by its own thread, so that nothing it prints is ever missed."""

    def __init__(self, device: str, path: Path, on_line=None, redact=None):
        self.port = serial.Serial(device, 115200, timeout=0.1)
        self.log = open(path, "a", buffering=1, errors="replace")
        self.on_line = on_line
        self.redact = redact
        self.chunks = collections.deque()
        self.ready = threading.Event()
        self.stopping = False
        self.partial = b""
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self) -> None:
        while not self.stopping:
            try:
                data = self.port.read(4096)
            except (OSError, serial.SerialException):
                time.sleep(0.5)
                continue
            if not data:
                continue
            self.chunks.append(data)
            self.ready.set()
            self.partial += data
            while b"\n" in self.partial:
                line, self.partial = self.partial.split(b"\n", 1)
                text = line.decode("utf-8", "replace").rstrip("\r")
                if self.redact:
                    text = self.redact(text)
                self.log.write(f"{time.strftime('%H:%M:%S')} {text}\n")
                if self.on_line:
                    self.on_line(text)

    # The part of the pyserial interface that board.Console uses.
    def read(self, size: int) -> bytes:
        if not self.chunks and not self.ready.wait(0.2):
            return b""
        self.ready.clear()
        data = b""
        while self.chunks and len(data) < size:
            data += self.chunks.popleft()
        return data

    def write(self, data: bytes) -> int:
        return self.port.write(data)

    def reset_input_buffer(self) -> None:
        self.chunks.clear()
        self.ready.clear()

    def close(self) -> None:
        self.stopping = True
        self.thread.join(timeout=2)
        self.port.close()
        self.log.close()


class BenchConsole(Console):
    """board.Console on a port that keeps a log."""

    def __init__(self, device: str, path: Path):
        super().__init__(device, LoggedPort(device, path))


class Aws:
    def __init__(self, profile: str, region: str):
        self.base = ["aws", "--profile", profile, "--region", region, "--output", "json",
                     "--no-cli-pager"]

    def call(self, *args: str, check: bool = True) -> dict:
        result = subprocess.run(self.base + list(args), capture_output=True, text=True)
        if result.returncode != 0:
            if check:
                raise TestFailed(f"aws {' '.join(args[:2])}: {result.stderr.strip()[:400]}")
            return {"__error__": result.stderr}
        return json.loads(result.stdout) if result.stdout.strip() else {}


def image_version(data: bytes) -> str:
    """The version in an MCUboot header."""
    magic = int.from_bytes(data[0:4], "little")
    if magic != 0x96f3b83d:
        raise TestFailed("not an MCUboot image")
    major, minor = data[20], data[21]
    revision = int.from_bytes(data[22:24], "little")
    build = int.from_bytes(data[24:28], "little")
    return f"{major}.{minor}.{revision}+{build}"


class Bench:
    def __init__(self, args):
        self.args = args
        self.outputs = json.loads(OUTPUTS.read_text())
        self.region = self.outputs["Region"]
        self.bucket = self.outputs["FirmwareBucketName"]
        self.aws = Aws(os.environ.get("AWS_PROFILE", "cranium"), self.region)
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.boot_lines = collections.deque(maxlen=4000)
        ports = sorted(p.device for p in list_ports.comports()
                       if p.vid == 0x1366 and "usbmodem" in p.device.lower())
        console_device = find_console_port()
        boot_device = next(p for p in ports if p != console_device)
        self.boot = LoggedPort(boot_device, self.out / "vcom0-boot.log", self.boot_lines.append)
        self.console = BenchConsole(console_device, self.out / "vcom1-app.log")
        self.thing = None
        self.release_manager = None
        self.presign_role = None

    def close(self) -> None:
        self.boot.close()
        self.console.serial.close()

    # ---- the board ----------------------------------------------------------------

    def status(self) -> dict | None:
        try:
            return self.console.status()
        except BoardError:
            return None

    def wait_status(self, description: str, predicate, timeout: float, every: float = 2) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.status()
            if status and predicate(status):
                return status
            time.sleep(every)
        raise TestFailed(f"timed out after {timeout:.0f} s waiting for: {description}; "
                         f"last status {self.status()}")

    def wait_online(self, timeout: float = 240) -> dict:
        status = self.wait_status("the board to be connected and idle",
                                  lambda s: s.get("cloud") == "connected"
                                  and s.get("update", "").startswith("idle"), timeout)
        self.thing = status["thing name"]
        return status

    def press(self, button: int) -> None:
        if self.args.real_button:
            note(f"PRESS BUTTON {button} ON THE BOARD NOW")
            return
        self.console.press(button)
        note(f"pressed Button {button}")

    def reset_board(self) -> None:
        # The reset pin, as with the RESET button: a system reset goes through the CPU's
        # debug access, which is refused while the bootloader is in the middle of a swap.
        result = subprocess.run(["nrfutil", "device", "reset", "--reset-kind", "RESET_PIN",
                                 "--serial-number", self.args.serial_number],
                                capture_output=True, text=True)
        if result.returncode != 0:
            raise TestFailed(f"the reset failed: {(result.stderr or result.stdout).strip()[:300]}")
        note("reset the board through its reset pin")

    def boot_log_has(self, pattern: str, since: int = 0) -> bool:
        lines = list(self.boot_lines)[since:]
        return any(re.search(pattern, line) for line in lines)

    # ---- the cloud ----------------------------------------------------------------

    def shadow(self) -> dict:
        with tempfile.NamedTemporaryFile(suffix=".json") as file:
            result = subprocess.run(self.aws.base + ["iot-data", "get-thing-shadow", "--thing-name",
                                                     self.thing, file.name],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                raise TestFailed(f"get-thing-shadow: {result.stderr.strip()[:300]}")
            return json.loads(Path(file.name).read_text())["state"]["reported"]

    def execution(self, job_id: str) -> dict:
        reply = self.aws.call("iot", "describe-job-execution", "--job-id", job_id, "--thing-name",
                              self.thing, check=False)
        return reply.get("execution", {})

    def wait_job(self, job_id: str, timeout: float, follow=None) -> dict:
        """Wait for the execution to finish, reporting every step it takes."""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            execution = self.execution(job_id)
            status = execution.get("status")
            details = execution.get("statusDetails", {}).get("detailsMap", {})
            seen = (status, json.dumps(details, sort_keys=True))
            if seen != last:
                note(f"job {status} {details}")
                last = seen
            if status in FINISHED:
                return execution
            if follow:
                follow()
            time.sleep(4)
        raise TestFailed(f"job {job_id} did not finish in {timeout:.0f} s: {last}")

    def put_object(self, data: bytes, name: str) -> None:
        with tempfile.NamedTemporaryFile(suffix=".bin") as file:
            file.write(data)
            file.flush()
            checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
            # The bucket refuses an upload that does not ask for a new key. The name
            # is the digest of the content, so a key that is taken holds these bytes.
            reply = self.aws.call("s3api", "put-object", "--bucket", self.bucket, "--key",
                                  f"firmware/{name}.bin", "--body", file.name,
                                  "--checksum-sha256", checksum, "--if-none-match", "*",
                                  check=False)
            if "__error__" in reply and "PreconditionFailed" not in reply["__error__"]:
                raise TestFailed(f"put-object: {reply['__error__'].strip()[:300]}")

    def bench_job(self, version: str, size: int, sha256: str, object_name: str | None = None) -> str:
        """A job as the console makes one, for what the console itself would refuse."""
        if self.presign_role is None:
            reply = self.aws.call("cloudformation", "describe-stack-resource", "--stack-name",
                                  "cranium-ota", "--logical-resource-id", "PresignRole")
            name = reply["StackResourceDetail"]["PhysicalResourceId"]
            self.presign_role = self.aws.call("iam", "get-role", "--role-name", name)["Role"]["Arn"]
        url = (f"https://s3.{self.region}.amazonaws.com/{self.bucket}/firmware/"
               f"{object_name or sha256}.bin")
        document = json.dumps({"op": "fw_update", "v": 1, "fw": {
            "version": version, "size": size, "sha256": sha256,
            "url": f"${{aws:iot:s3-presigned-url-v2:{url}}}"}}, separators=(",", ":"))
        job_id = f"cranium-bench-{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(2)}"
        account_arn = self.aws.call("iot", "describe-thing", "--thing-name", self.thing)["thingArn"]
        self.aws.call("iot", "create-job", "--job-id", job_id, "--targets", account_arn,
                      "--target-selection", "SNAPSHOT", "--document", document,
                      "--description", "Hardware test bench",
                      "--presigned-url-config",
                      json.dumps({"roleArn": self.presign_role, "expiresInSec": URL_EXPIRES_SEC}),
                      "--timeout-config",
                      json.dumps({"inProgressTimeoutInMinutes": JOB_TIMEOUT_MIN}))
        note(f"created {job_id} for {version}")
        return job_id

    def api(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        """Invoke the deployed API function, as the gateway does for a signed-in user."""
        if self.release_manager is None:
            self.release_manager = self.find_release_manager()
        now = int(time.time())
        event = {
            "version": "2.0", "routeKey": "ANY /api/{proxy+}", "rawPath": path, "rawQueryString": "",
            "headers": {"content-type": "application/json", "user-agent": "cranium-ota-bench"},
            "requestContext": {
                "authorizer": {"jwt": {"claims": {
                    "client_id": self.outputs["UserPoolClientId"],
                    "cognito:groups": "[release-managers]", "exp": str(now + 300), "iat": str(now),
                    "scope": "openid cranium/console", "sub": self.release_manager,
                    "token_use": "access", "username": self.release_manager},
                    "scopes": ["cranium/console"]}},
                "http": {"method": method, "path": path, "protocol": "HTTP/1.1",
                         "sourceIp": "127.0.0.1", "userAgent": "cranium-ota-bench"},
                "requestId": f"bench-{secrets.token_hex(8)}", "routeKey": "ANY /api/{proxy+}",
                "stage": "$default", "timeEpoch": now * 1000},
            "isBase64Encoded": False}
        if body is not None:
            event["body"] = json.dumps(body)
        with tempfile.TemporaryDirectory() as folder:
            request, answer = Path(folder) / "event.json", Path(folder) / "answer.json"
            request.write_text(json.dumps(event))
            reply = self.aws.call("lambda", "invoke", "--function-name",
                                  self.outputs["ApiFunctionName"], "--cli-read-timeout", "60",
                                  "--payload", f"fileb://{request}", str(answer))
            if reply.get("FunctionError"):
                raise TestFailed(f"the API function failed: {answer.read_text()[:400]}")
            response = json.loads(answer.read_text())
        return response["statusCode"], json.loads(response.get("body") or "{}")

    def find_release_manager(self) -> str:
        users = self.aws.call("cognito-idp", "list-users-in-group", "--user-pool-id",
                              self.outputs["UserPoolId"], "--group-name", "release-managers")["Users"]
        for user in users:
            attributes = {a["Name"]: a["Value"] for a in user["Attributes"]}
            wanted = self.args.as_user == attributes.get("email")
            if wanted and user["Enabled"] and user["UserStatus"] == "CONFIRMED":
                note(f"acting in the API as {attributes.get('email')}")
                return attributes["sub"]
        raise TestFailed(f"{self.args.as_user} is not an enabled, confirmed release manager: "
                         "is the first sign-in to the console still outstanding?")

    def release(self, data: bytes, filename: str) -> tuple[str, str]:
        """Upload through the console API, unless that release is already registered."""
        version = image_version(data)
        # The console takes letters, digits, dots, dashes and underscores in a file name.
        filename = re.sub(r"[^A-Za-z0-9._-]", "-", filename)[:64]
        status, body = self.api("POST", "/api/firmware", {
            "filename": filename, "notes": "Uploaded by the hardware test bench",
            "data": base64.b64encode(data).decode()})
        if status == 409 and body.get("error", {}).get("code") == "version_exists":
            note(f"release {version} is already registered")
        elif status not in (200, 201):
            raise TestFailed(f"upload of {version} answered {status}: {body}")
        else:
            note(f"uploaded release {version} through the console API")
        return version, hashlib.sha256(data).hexdigest()

    def deploy(self, version: str) -> str:
        status, body = self.api("POST", "/api/deployments", {
            "version": version, "things": [self.thing], "note": "Hardware test bench"})
        if status not in (200, 201):
            raise TestFailed(f"deployment of {version} answered {status}: {body}")
        job_id = body.get("id") or body.get("deployment", {}).get("id")
        note(f"created deployment {job_id} through the console API")
        return job_id

    def offer(self, data: bytes, filename: str) -> tuple[str, str]:
        """Make a job for the image in the way --via says. Returns (job id, version)."""
        version = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        if self.args.via == "api":
            self.release(data, filename)
            return self.deploy(version), version
        self.put_object(data, sha256)
        return self.bench_job(version, len(data), sha256), version

    def wait_offered(self, job_id: str) -> None:
        status = self.wait_status("the board to offer the update",
                                  lambda s: s.get("update", "").startswith("awaiting_user"), 90)
        note(f"board offers the update: {status['update']}")

    # ---- scenarios ----------------------------------------------------------------

    def update(self, path: Path) -> dict:
        data = path.read_bytes()
        before = self.wait_online()
        target = image_version(data)
        start = time.time()
        marks = {}
        job_id, _ = self.offer(data, path.name)
        self.wait_offered(job_id)
        marks["offered"] = time.time() - start
        self.press(1)
        pressed = time.time()

        def follow():
            status = self.status()
            state = status.get("update", "").split(" ")[0] if status else "restarting"
            if state not in marks and state != "idle":
                marks[state] = time.time() - pressed
                note(f"board: {state} after {marks[state]:.0f} s")

        execution = self.wait_job(job_id, 900, follow)
        marks["total_after_press"] = time.time() - pressed
        if execution.get("status") != "SUCCEEDED":
            raise TestFailed(f"job ended {execution.get('status')}: {execution.get('statusDetails')}")
        status = self.wait_online()
        if status.get("firmware") != target:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {target}")
        reported = self.shadow()["fw"]
        if reported != {"version": target, "confirmed": True}:
            # The next shadow report follows a moment after the job's final status.
            time.sleep(8)
            reported = self.shadow()["fw"]
            if reported != {"version": target, "confirmed": True}:
                raise TestFailed(f"shadow says {reported}, expected {target} confirmed")
        note(f"updated {before.get('firmware')} -> {target} in {marks['total_after_press']:.0f} s "
             f"after the button")
        return {"from": before.get("firmware"), "to": target, "job": job_id,
                "seconds": {k: round(v) for k, v in marks.items()}}

    def expect_refusal(self, job_id: str, status_wanted: str, reason: str, running: str,
                       timeout: float = 600, follow=None) -> dict:
        execution = self.wait_job(job_id, timeout, follow)
        details = execution.get("statusDetails", {}).get("detailsMap", {})
        if execution.get("status") != status_wanted or details.get("reason") != reason:
            raise TestFailed(f"expected {status_wanted}/{reason}, got "
                             f"{execution.get('status')}/{details}")
        status = self.wait_online()
        if status.get("firmware") != running:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {running} still")
        return {"job": job_id, "status": status_wanted, "reason": reason, "running": running}

    def expect_last(self, wanted: str) -> None:
        """What the console shows as the board's last result has to stay what happened,
        also after the replies that were still on their way have arrived."""
        time.sleep(6)
        last = self.shadow()["ota"]["last"]
        if last != wanted:
            raise TestFailed(f"the board reports its last result as {last}, expected {wanted}")

    def decline(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        job_id, _ = self.offer(data, path.name)
        self.wait_offered(job_id)
        self.press(2)
        return self.expect_refusal(job_id, "REJECTED", "declined", running, 60)

    def cancel(self, job_id: str, force: bool) -> None:
        if job_id.startswith("cranium-bench-"):
            arguments = ["iot", "cancel-job", "--job-id", job_id]
            if force:
                arguments.append("--force")
            self.aws.call(*arguments)
        else:
            status, body = self.api("POST", f"/api/deployments/{job_id}/cancel", {"force": force})
            if status not in (200, 202):
                raise TestFailed(f"cancellation answered {status}: {body}")
        note(f"cancelled {job_id}{' with force' if force else ''}")

    def cancel_offer(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        job_id, _ = self.offer(data, path.name)
        self.wait_offered(job_id)
        self.cancel(job_id, False)
        status = self.wait_status("the offer to disappear",
                                  lambda s: s.get("update", "").startswith("idle"), 90)
        if status.get("firmware") != running:
            raise TestFailed(f"firmware changed to {status.get('firmware')}")
        return {"job": job_id, "last": status.get("update"), "running": running}

    def cancel_stop(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        job_id, _ = self.offer(data, path.name)
        self.wait_offered(job_id)
        self.press(1)
        self.wait_status("the download to start",
                         lambda s: s.get("update", "").startswith("downloading"), 90, 1)
        time.sleep(6)
        self.cancel(job_id, True)
        mark = len(self.boot_lines)
        status = self.wait_status("the board to drop the update",
                                  lambda s: s.get("update", "").startswith("idle"), 240, 3)
        if status.get("firmware") != running:
            raise TestFailed(f"firmware changed to {status.get('firmware')}")
        time.sleep(30)
        status = self.wait_online()
        if status.get("firmware") != running or self.boot_log_has("Starting bootloader", mark):
            raise TestFailed("the board restarted or changed firmware after the cancellation")
        return {"job": job_id, "last": status.get("update"), "running": running}

    def older(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        version = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        job_id = self.bench_job(version, len(data), sha256)
        return self.expect_refusal(job_id, "REJECTED", "not_newer", running, 90)

    def corrupt(self, path: Path) -> dict:
        data = bytearray(path.read_bytes())
        running = self.wait_online()["firmware"]
        version = image_version(bytes(data))
        sha256 = hashlib.sha256(data).hexdigest()
        data[len(data) // 2] ^= 0x40
        damaged = hashlib.sha256(data).hexdigest()
        self.put_object(bytes(data), damaged)
        job_id = self.bench_job(version, len(data), sha256, damaged)
        self.wait_offered(job_id)
        self.press(1)
        return self.expect_refusal(job_id, "FAILED", "digest_mismatch", running, 420)

    def bad_signature(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        version = image_version(data)
        hdr_size = int.from_bytes(data[8:10], "little")
        img_size = int.from_bytes(data[12:16], "little")
        tool = Path(os.environ["ZEPHYR_BASE"]).parent / "bootloader/mcuboot/scripts/imgtool.py"
        with tempfile.TemporaryDirectory() as folder:
            key, raw, signed = (Path(folder) / n for n in ("other.pem", "raw.bin", "signed.bin"))
            raw.write_bytes(data[hdr_size:hdr_size + img_size])
            subprocess.run([sys.executable, str(tool), "keygen", "-t", "ecdsa-p256", "-k", str(key)],
                           check=True, capture_output=True)
            subprocess.run([sys.executable, str(tool), "sign", "--key", str(key), "--version", version,
                            "--slot-size", "0xe4000", "--header-size", hex(hdr_size), "--pad-header",
                            "--align", "4", "--rom-fixed", "0x30000", str(raw), str(signed)],
                           check=True, capture_output=True)
            forged = signed.read_bytes()
        sha256 = hashlib.sha256(forged).hexdigest()
        self.put_object(forged, sha256)
        job_id = self.bench_job(version, len(forged), sha256)
        self.wait_offered(job_id)
        mark = len(self.boot_lines)
        self.press(1)
        result = self.expect_refusal(job_id, "FAILED", "not_installed", running, 600)
        self.expect_last("failed")
        if not self.boot_log_has(r"(?i)not valid|invalid|signature|Image in the secondary", mark):
            raise TestFailed("the boot log does not show the bootloader refusing the image")
        result["bootloader"] = [line for line in list(self.boot_lines)[mark:]
                                if re.search(r"(?i)not valid|invalid|signature|secondary", line)][:6]
        return result

    def faulty(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        target = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        job_id = self.bench_job(target, len(data), sha256)
        self.wait_offered(job_id)
        mark = len(self.boot_lines)
        started = time.time()
        self.press(1)
        result = self.expect_refusal(job_id, "FAILED", "rolled_back", running, 900)
        self.expect_last("rolled_back")
        if not self.boot_log_has(r"Swap type: test", mark):
            raise TestFailed("the boot log shows no trial swap")
        if not self.boot_log_has(r"Swap type: revert", mark):
            raise TestFailed("the boot log shows no revert")
        result["seconds"] = round(time.time() - started)
        return result

    def reset_download(self, path: Path) -> dict:
        data = path.read_bytes()
        running = self.wait_online()["firmware"]
        target = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        job_id = self.bench_job(target, len(data), sha256)
        self.wait_offered(job_id)
        self.press(1)
        self.wait_status("the download to start",
                         lambda s: s.get("update", "").startswith("downloading"), 90, 1)
        time.sleep(5)
        self.reset_board()
        return self.expect_refusal(job_id, "FAILED", "interrupted", running, 240)

    def reset_swap(self, path: Path) -> dict:
        data = path.read_bytes()
        self.wait_online()
        target = image_version(data)
        sha256 = hashlib.sha256(data).hexdigest()
        self.put_object(data, sha256)
        job_id = self.bench_job(target, len(data), sha256)
        self.wait_offered(job_id)
        mark = len(self.boot_lines)
        self.press(1)
        deadline = time.time() + 480
        while not self.boot_log_has(r"Swap type: test", mark):
            if time.time() > deadline:
                raise TestFailed("the bootloader never started the swap")
            time.sleep(0.2)
        time.sleep(6)
        self.reset_board()
        execution = self.wait_job(job_id, 480)
        if execution.get("status") != "SUCCEEDED":
            raise TestFailed(f"job ended {execution.get('status')}: {execution.get('statusDetails')}")
        status = self.wait_online()
        if status.get("firmware") != target:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {target}")
        return {"job": job_id, "running": target}

    def recovery(self, path: Path) -> dict:
        target = image_version(path.read_bytes())
        data = path.read_bytes()
        hdr_size = int.from_bytes(data[8:10], "little")
        img_size = int.from_bytes(data[12:16], "little")
        tool = Path(os.environ["ZEPHYR_BASE"]).parent / "bootloader/mcuboot/scripts/imgtool.py"
        console_device = self.console.port
        self.console.serial.close()
        recover = [sys.executable, str(REPO / "tools" / "recover.py"), "--port", console_device]
        results = {}
        try:
            with tempfile.TemporaryDirectory() as folder:
                key, raw, forged = (Path(folder) / n for n in ("other.pem", "raw.bin", "forged.bin"))
                raw.write_bytes(data[hdr_size:hdr_size + img_size])
                subprocess.run([sys.executable, str(tool), "keygen", "-t", "ecdsa-p256", "-k", str(key)],
                               check=True, capture_output=True)
                subprocess.run([sys.executable, str(tool), "sign", "--key", str(key), "--version", target,
                                "--slot-size", "0xe4000", "--header-size", hex(hdr_size), "--pad-header",
                                "--align", "4", "--rom-fixed", "0x30000", str(raw), str(forged)],
                               check=True, capture_output=True)
                mark = len(self.boot_lines)
                note("sending an image signed with another key through serial recovery")
                subprocess.run(recover + ["--reset", "upload", str(forged)], check=True, text=True)
                time.sleep(4)
                refused = [line for line in list(self.boot_lines)[mark:]
                           if re.search(r"(?i)not valid|invalid|Unable to find bootable|signature", line)]
                if not refused:
                    raise TestFailed("the bootloader did not refuse the badly signed image")
                note(f"refused: {refused[0]}")
                results["refused"] = refused[:4]
            note("sending the correctly signed image")
            mark = len(self.boot_lines)
            subprocess.run(recover + ["upload", str(path)], check=True, text=True)
            results["installed"] = target
        finally:
            self.console = BenchConsole(console_device, self.out / "vcom1-app.log")
        # The board has been off the network for minutes, and a phone's hotspot may have
        # stopped being visible in that time.
        status = self.wait_online(600)
        if status.get("firmware") != target:
            raise TestFailed(f"board runs {status.get('firmware')}, expected {target}")
        return results


SCENARIOS = {
    "decline": Bench.decline, "cancel-offer": Bench.cancel_offer, "cancel-stop": Bench.cancel_stop,
    "older": Bench.older, "corrupt": Bench.corrupt, "bad-signature": Bench.bad_signature,
    "faulty": Bench.faulty, "reset-download": Bench.reset_download, "reset-swap": Bench.reset_swap,
    "recovery": Bench.recovery,
}


def run(bench: Bench, name: str, function, path: Path) -> bool:
    note(f"=== {name} {path.name}")
    started = time.time()
    record = {"scenario": name, "image": path.name, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    try:
        record["result"] = function(bench, path)
        record["outcome"] = "PASS"
    except (TestFailed, BoardError, subprocess.CalledProcessError) as error:
        record["outcome"] = "FAIL"
        record["error"] = str(error)
    record["duration"] = round(time.time() - started)
    with open(bench.out / "results.jsonl", "a") as file:
        file.write(json.dumps(record) + "\n")
    note(f"=== {record['outcome']} {name} {path.name} ({record['duration']} s)"
         + (f": {record['error']}" if "error" in record else ""))
    return record["outcome"] == "PASS"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["status", "update", *SCENARIOS])
    parser.add_argument("images", nargs="*", type=Path)
    parser.add_argument("--via", choices=["api", "direct"], default="api",
                        help="how update, decline and the cancel scenarios create their job")
    parser.add_argument("--as", dest="as_user", help="the release manager to act as in the API")
    parser.add_argument("--out", default=str(REPO / "build-hil"), help="where logs and results go")
    parser.add_argument("--real-button", action="store_true",
                        help="wait for a person to press the button instead of using the "
                             "console's BUTTON command")
    parser.add_argument("--serial-number", default="001050797470")
    parser.add_argument("--stop-on-failure", action="store_true")
    args = parser.parse_args()
    # Through the API, a release goes into the activity log in somebody's name: say whose.
    if args.via == "api" and args.as_user is None and args.command != "status":
        parser.error("--via api acts as a release manager: name one with --as <email>")

    bench = Bench(args)
    try:
        if args.command == "status":
            bench.wait_online(30)
            status = bench.status()
            for key, value in status.items():
                print(f"  {key:<14} {value}")
            print("  shadow        ", json.dumps(bench.shadow()))
            return 0
        function = Bench.update if args.command == "update" else SCENARIOS[args.command]
        if not args.images:
            parser.error("this command needs an image")
        failures = 0
        for path in args.images:
            if not run(bench, args.command, function, path):
                failures += 1
                if args.stop_on_failure:
                    break
        note(f"{len(args.images) - failures} of {len(args.images)} passed")
        return 1 if failures else 0
    finally:
        bench.close()


if __name__ == "__main__":
    sys.exit(main())
