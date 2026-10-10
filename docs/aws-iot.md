# Firmware updates through AWS IoT

How the Cranium boards, AWS IoT and the firmware console work together. Account-specific
values (account ID, endpoints, bucket and pool names) are never written here or anywhere
else in the repository: `cloud/deploy.sh` stores them in the ignored `cloud/.deploy/`.

```
                    signed image (HTTPS)                        HTTPS GET, signed link (10 min)
  release manager ─────────────────────▶ firmware console ──▶ S3 ◀──────────────────────────┐
        browser         sign-in: Cognito   API Gateway + Lambda                              │
                        password + TOTP          │ creates a job                             │
                                                 ▼                                           │
                                           AWS IoT Core ◀── MQTT, mutual TLS ──▶ nRF7002 DK ─┘
                                           jobs · shadows · thing registry          Wi-Fi
```

## What is deployed

Two CloudFormation stacks, `cranium-ota-bootstrap` and `cranium-ota`
(`cloud/infra/`), plus `cranium-budget` for the cost alert.

| Resource | Purpose |
| --- | --- |
| IoT thing group `cranium-devices` | The fleet. The console lists and deploys to its members only. |
| IoT policy `cranium-device` | What a board may do (below). Attached to each board's certificate. |
| IoT jobs `cranium-…` | One job per deployment. AWS IoT is the only record of a deployment. |
| S3 bucket | Firmware images, stored once under their SHA-256. Private, versioned, write-once. |
| IAM role for signing links | Lets AWS IoT Jobs (and nothing else) create a download link for an image. |
| DynamoDB tables | The list of releases, and an append-only audit log. |
| Cognito user pool | Console accounts: created by an administrator, password plus authenticator app. |
| HTTP API and two Lambda functions | The console: one function serves the page, one is the API. |
| CloudWatch log groups | API access log, function logs, AWS IoT logs. |

## A board's identity

Each board is one *thing* named `cranium-<16 hex digits>`, derived from the nRF5340's
hardware ID, with one X.509 certificate of its own.

`python3 tools/provision_device.py` does the following over the board's serial console:

1. Sends the Wi-Fi network from `~/.cranium/wifi_secrets.h`. The board stores it in TF-M.
2. Asks the board to create a P-256 key pair. The private key is generated on the board
   and stays there; the board prints a certificate signing request.
3. Registers the board in AWS IoT:
   `create-thing`, `add-thing-to-thing-group`, `create-certificate-from-csr`,
   `attach-policy`, and `attach-thing-principal` with `EXCLUSIVE_THING`, so the
   certificate cannot be attached to a second thing.
4. Loads the certificate and Amazon Root CA 1 into the board (TF-M Protected Storage),
   and tells it the AWS IoT endpoint and the one URL prefix it may download from.

Nothing account-specific and no credential is compiled into the firmware, so the image
in S3 and in the board's external flash holds no secrets.

To retire a certificate (lost or stolen board):

```sh
aws iot update-certificate --certificate-id <id> --new-status INACTIVE
aws iot detach-thing-principal --thing-name <thing> --principal <certificate arn>
```

Provisioning the board again with `--new-identity` creates a new key pair and
certificate and retires the old one.

## What a board may do

The policy uses the thing name of the connecting client, so a certificate only works for
its own thing and its own topics. `T` stands for that thing name.

| Action | Resource |
| --- | --- |
| Connect | client ID `T`, and only while the certificate is attached to thing `T` |
| Publish | `$aws/things/T/shadow/update`, `$aws/things/T/jobs/$next/get`, `$aws/things/T/jobs/<job>/update` |
| Subscribe, receive | `$aws/things/T/jobs/notify-next`, `$aws/things/T/jobs/$next/get/*`, `$aws/things/T/jobs/<job>/update/*` |

A board cannot read or write another board's shadow or jobs, cannot publish to any other
topic, and has no last-will message.

## Shadow: what the console shows about a board

The board writes its state to its classic shadow when something changes and at least
once a minute:

```json
{ "state": { "reported": {
    "fw":   { "version": "1.0.1+0", "confirmed": true },
    "ota":  { "state": "idle", "job": null, "progress": 0, "last": "succeeded", "error": "" },
    "wifi": { "rssi": -52 },
    "uptime": 1234 } } }
```

`ota.state` is `idle`, `awaiting_user`, `downloading`, `verifying`, `rebooting` or
`testing`. The console treats a board as online when its last report is younger than
150 seconds. Everything in a shadow comes from the board, so the console validates each
field before showing it and never bases a decision on it.

## An update, message by message

The job document:

```json
{ "op": "fw_update", "v": 1,
  "fw": { "version": "1.0.1+0", "size": 768066, "sha256": "<64 hex digits>",
          "url": "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/firmware/<sha256>.bin}" } }
```

AWS IoT replaces the placeholder with a signed link each time the board asks for the
document, so a link is never stored and is valid for 10 minutes only.

| Step | Board | Job execution | Shadow `ota.state` |
| --- | --- | --- | --- |
| Deployment created | gets `notify-next`, asks for `$next` | `QUEUED` | `idle` |
| Document checked: known format, strictly newer version, fits the slot, allowed URL prefix | waits for a button | `QUEUED` | `awaiting_user` |
| Button 2 (decline), or a check failed | reports the refusal | `REJECTED`, `reason` | `idle` |
| Button 1 | asks for the document again (fresh link), announces the start, waits for AWS IoT to accept | `IN_PROGRESS`, `step=downloading` | `downloading` |
| Download over HTTPS into the secondary slot | | | `downloading`, `progress` |
| SHA-256 and signed header checked | announces the installation, waits for AWS IoT to accept | `IN_PROGRESS`, `step=rebooting` | `verifying`, then `rebooting` |
| Reset: MCUboot verifies the signature and swaps | | | |
| New image running on trial | reconnects to AWS IoT, confirms itself | `SUCCEEDED`, `running` | `testing`, then `idle` |
| Not confirmed within 5 minutes | reset, MCUboot swaps back, old image reports | `FAILED`, `reason=rolled_back` | `idle` |

Because an offered update stays `QUEUED` until the button is pressed, cancelling a
deployment simply withdraws it. Because the board waits for AWS IoT to accept both
announcements, an update that is cancelled, or whose release is revoked, after the
button press is dropped before it is installed.

Failure reasons a board can report: `download_failed`, `digest_mismatch`,
`header_mismatch`, `flash_error`, `interrupted`, `rolled_back`, `not_installed`.
Refusal reasons: `bad_document`, `unsupported`, `url_not_allowed`, `not_newer`,
`too_large`, `declined`.

### The download link

Measured on the deployed setup: the link has the form
`https://<bucket>.s3.<region>.amazonaws.com/firmware/<sha256>.bin?X-Amz-…`, is about
1,200 characters long (the board accepts up to 2,047 after the host name) and the whole
jobs message is about 1.6 kB (the board's buffer is 4 kB). The board only downloads from
the provisioned prefix `https://<bucket>.s3.<region>.amazonaws.com/firmware/`, over TLS
verified against Amazon Root CA 1, using a credential slot that holds no client key.

## The console

Sign-in is through Cognito: accounts are created by an administrator, and every account
needs a password and a code from an authenticator app. *Viewers* can look; *release
managers* can upload, deploy, cancel and revoke.

- **Upload.** The console accepts only an MCUboot image whose SHA-256 and ECDSA P-256
  signature verify against this project's public key, built for this product's flash
  layout, with a version higher than every release registered before. It holds the
  public key only: it can check a signature but never create one.
- **Deploy.** Pick a release and boards. A board with an unfinished update is not offered
  another one.
- **Cancel.** Withdraws the offer from boards that have not started. With *force*, boards
  that already started stop before installing.
- **Revoke.** Marks a release as bad: no new deployments, running deployments of it are
  cancelled, and its file is tagged so that S3 refuses every download, including links
  that were already issued.
- **Activity.** Every upload, deployment, cancellation and revocation, with who did it
  and whether it was allowed.

## Operating it

```sh
aws login --profile cranium                     # browser sign-in, valid for 12 hours
export AWS_PROFILE=cranium AWS_REGION=us-east-1

cloud/deploy.sh                                 # create or update the stacks
cloud/users.sh add <email> release-manager      # the person gets an invitation by e-mail
cloud/smoke.sh                                  # checks that do not need a sign-in

python3 tools/secrets.py wifi                   # once per machine
python3 tools/provision_device.py               # once per board
```

Releasing an update:

1. Raise the version in `firmware/app/VERSION` and build. The build signs the image with
   the key in `~/.cranium/`.
2. In the console, upload `firmware/app/build/app/zephyr/zephyr.signed.bin`.
3. Deploy it, then press Button 1 on each board.

`cloud/logs.sh api|web|access|iot` follows the logs. `cloud/teardown.sh` removes
everything.

## Security decisions

| Rule from the lectures | How it is met |
| --- | --- |
| Signed firmware; devices hold only the public key | MCUboot verifies ECDSA P-256 over SHA-256 on every boot and before every swap. The console repeats the check on upload. |
| Signing kept away from the online server | The console is verify-only. A break-in there cannot produce firmware that a board accepts. |
| Unique identity per device; keys generated on the device | One certificate per thing; the private key is generated in the board and never leaves it. |
| One key, one mission | Separate keys for firmware signing, device identity and storage encryption. The download connection uses a credential slot without the device key. |
| Keys isolated from application software | Device credentials are in TF-M Protected Storage; TLS and signing run through PSA Crypto in the secure world. |
| TLS everywhere, forward secrecy, authenticated encryption | MQTT with mutual TLS on port 8883 and HTTPS for the download. The firmware offers only ECDHE with AES-GCM. The bucket refuses plain HTTP. |
| Least privilege | The device policy is limited to the board's own topics. The console's roles have no delete, publish, signing or certificate rights. |
| Secure update: safe failure, no rollback to old firmware | Trial boot with automatic revert; version checks in the console, the application and MCUboot; user consent on the board. |
| No default or shared passwords, two-factor sign-in | Administrator-created accounts with a temporary password and a required authenticator code. |
| Log security-relevant actions, never secrets | Audit log that the API can only append to; access log without query strings; no tokens, links or request bodies in any log. |
| Only the servers a device needs | The board talks to its AWS IoT endpoint and downloads from one bucket prefix. |

Known limits, stated plainly:

- The board speaks TLS 1.2; TLS 1.3 is not enabled in this build.
- The update image is not encrypted in S3 or in external flash. It contains no secrets,
  but it can be copied by someone who holds the board.
- The signing key is a file on the release builder's machine. Moving it into AWS KMS
  (sign with `imgtool --vector-to-sign`, `aws kms sign`, `imgtool --fix-sig`) would mean
  no person holds it at all.
- Downgrade protection is by version comparison in MCUboot, not by a hardware counter.
- The development kit's debug port is open. A product build locks it (APPROTECT) and
  leaves out the provisioning shell.

## Cost

Everything is pay-per-use and, for four boards and four users, comes to well under one
US dollar a month: a board's one-minute report is about 45,000 messages a month, and the
console's functions and tables see a few thousand requests. The `cranium-budget` stack
sends an e-mail when the monthly cost passes its thresholds.
