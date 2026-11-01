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
(`cloud/infra/`), plus `cranium-budget` for the cost alert. `cloud/trail.sh` adds a separate
stack, `cranium-trail`, with a CloudTrail record of management events.

| Resource | Purpose |
| --- | --- |
| IoT thing group `cranium-devices` | The fleet. The console lists and deploys to its members only. |
| IoT policy `cranium-device` | What a board may do (below). Attached to each board's certificate. |
| IoT jobs `cranium-…` | One job per deployment. AWS IoT is the only record of a deployment. The hardware bench also creates `cranium-bench-…` jobs, which the console's deployment list leaves out and a revocation does not cancel. |
| S3 bucket | Firmware images, stored once under their SHA-256. Private, versioned, write-once. The bench also stores test images here, including damaged and wrongly signed ones. Boards refuse those. |
| IAM role for signing links | Lets AWS IoT Jobs (and nothing else) create a download link for an image. |
| DynamoDB tables | The list of releases, and the audit log. The API's role may put and query audit entries, and nothing else. What that does and does not guarantee is under [Security decisions](#security-decisions). |
| Cognito user pool | Console accounts: created by an administrator, password plus authenticator app. |
| HTTP API and two Lambda functions | The console and the public home page: one function serves the pages, one is the console's API. |
| CloudWatch log groups | API access log, function logs, AWS IoT logs. |

## A board's identity

Each board is one *thing* named `cranium-<16 hex digits>`, derived from the nRF5340's
hardware ID, with one X.509 certificate of its own.

`python3 tools/provision_device.py` does the following over the board's serial console (firmware
1.3.0 or later, see [`firmware/README.md`](../firmware/README.md#serial-console)):

1. Sets the device ID of a board in factory mode (`INIT`), then sends the Wi-Fi network
   from `~/.cranium/wifi_secrets.h`. The board stores it in TF-M.
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
`testing`. A build for firmware update over Bluetooth can also report `bluetooth`, which the console
does not know and leaves out. The console treats a board as online when its last report is younger than
150 seconds. Everything in a shadow comes from the board, so the console validates each
field before showing it and never bases a decision on it.

## An update, message by message

An example job document:

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
| 20 seconds later | fetches the job once more; goes on only if it is still in progress | | `rebooting` |
| Reset: MCUboot verifies the signature and swaps | | | |
| New image running on trial | reconnects to AWS IoT, confirms itself | `SUCCEEDED`, `running` | `testing`, then `idle` |
| Not confirmed within 5 minutes, or the watchdog fires (120 seconds) | reset, MCUboot swaps back, old image reports | `FAILED`, `reason=rolled_back` | `idle` |

Because an offered update stays `QUEUED` until the button is pressed, cancelling a
deployment simply withdraws it. Because the board waits for AWS IoT to accept both
announcements, an update that is cancelled, or whose release is revoked, after the
button press is dropped before it is installed.

AWS IoT applies a forced cancellation a few seconds after it is requested (5 to 15
seconds, measured), and still accepts a board's announcements until then. That is why
the board waits 20 seconds after its second announcement and looks at the job once
more. Only then does it ask the bootloader for the swap, so a reset during the wait
installs nothing.

Failure reasons a board can report: `download_failed`, `digest_mismatch`,
`header_mismatch`, `flash_error`, `interrupted`, `rolled_back`, `not_installed`, `trial_lost`. The last
means that the board runs the update's version with nothing proving it and nothing to revert to: a
golden image restore cut off at its start can leave that, as can a serial upload of the same version.
Refusal reasons: `bad_document`, `unsupported`, `url_not_allowed`, `not_newer`,
`too_large`, `declined`.

### The download link

Measured on the deployed setup: the link has the form
`https://<bucket>.s3.<region>.amazonaws.com/firmware/<sha256>.bin?X-Amz-…`, is about
1,200 characters long (the board accepts up to 2,047 after the host name) and the whole
jobs message is about 1.6 kB (the board's buffer is 4 kB). The board only downloads from
the provisioned prefix `https://<bucket>.s3.<region>.amazonaws.com/firmware/`, over TLS
verified against Amazon Root CA 1, using a credential slot that holds no client key.

### Two TLS sessions at once

The MQTT connection stays up during a download, so that a cancellation still arrives. That
makes two TLS sessions on one Mbed TLS heap of 81,920 bytes. The second handshake first
failed with Mbed TLS error -141, which looked like a certificate problem. It was the heap
running out: the two sessions peaked at 86,192 bytes. Each session took 16 KB record buffers
in both directions. Setting `CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN=4096` brought the peak to
61,616 bytes. What comes in must still fit 16 KB, because neither S3 nor AWS IoT can be asked
to send shorter records.

## The console

The console is at https://console.craniumiot.com. The public home page, which signs nobody in, is at
https://craniumiot.com. Sign-in is through Cognito: accounts are created by an administrator, and every
account needs a password of at least 12 characters and a code from an authenticator app. A temporary
password works for 3 days. A session lasts 60 minutes. The console keeps no refresh token, so it then
asks for the password and the code again. *Viewers* can look; *release managers* can upload, deploy,
cancel and revoke. [`cloud/README.md`](../cloud/README.md#add-users) has the details.

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
- **Activity.** Every upload, deployment, cancellation and revocation that reaches the API
  function, with the person it names and whether it was allowed. Entries made by `scripts/ota.sh`
  or the test bench name the release manager they act for, not a signed-in session. Their request
  IDs start with `bench-`. Actions taken directly in AWS, such as the AWS CLI stop in
  `cloud/README.md`, the bench's own jobs or anything an administrator does, do not pass through
  the API and are not listed here.

## The Raspberry Pi (planned)

Only the nRF boards are updated today. The Raspberry Pi is to use the same thing
registry, device policy, jobs and bucket. It needs three additions:

- a job document of its own (`pi_update`);
- its own thing group and release list, so that the console never offers one board's
  image to the other;
- an upload that goes straight to S3, because a Pi bundle is hundreds of megabytes and the
  console's API takes at most 1.4 MB.

The design is in [raspberry-pi-ota.md](raspberry-pi-ota.md#decision).

## Operating it

```sh
aws login --profile cranium                     # browser sign-in, up to 12 hours
export AWS_PROFILE=cranium AWS_REGION=us-east-1

scripts/open-console.sh                         # sign in, deploy if needed, open the console
cloud/deploy.sh                                 # create or update the stacks
cloud/users.sh add <email> release-manager      # the person gets an invitation by e-mail
cloud/smoke.sh                                  # checks that do not need a sign-in

python3 tools/secrets.py wifi                   # once per machine, see secrets/README.md
python3 tools/provision_device.py               # once per board
```

A session can end sooner than that: one on 2026-11-01 ended after about 2 hours and 20 minutes. A long
bench run that needs AWS stops when it does.

Releasing an update:

1. Raise the version in `firmware/app/VERSION` and build. The build signs the image with
   the key in `~/.cranium/` and stores it in `binaries/`.
2. In the console, upload `binaries/latest.signed.bin`.
3. Deploy it, then press Button 1 on each board.

`scripts/ota.sh` does steps 2 and 3 for one board and follows the update to the end. It invokes
the API function directly, which bypasses API Gateway and sign-in (see [Known limits](#known-limits)).

After a new signing key, run `cloud/deploy.sh --replace-signing-key`, so that the console
trusts its public half. `secrets/README.md` covers the rest.

`cloud/logs.sh api|web|access|iot` follows the logs. `cloud/teardown.sh` removes the console and
what it stored. It leaves the budget stack, the `cranium-trail` stack with its log files, and the
log group `AWSIotLogsV2`.

## Security decisions

| Rule from the lectures | How it is met |
| --- | --- |
| Signed firmware; devices hold only the public key | MCUboot verifies ECDSA P-256 over SHA-256 on every boot and before every swap. The console repeats the check on upload. |
| Signing kept away from the online server | The console is verify-only. A break-in there cannot produce firmware that a board accepts. |
| Unique identity per device; keys generated on the device | One certificate per thing; the private key is generated in the board and never leaves it. |
| One key, one mission | Separate keys for firmware signing, device identity and storage encryption. The download connection uses a credential slot without the device key. |
| Keys isolated from application software | Partly met. Device credentials are in TF-M Protected Storage, encrypted with a key derived from the hardware unique key, and never in the image. TLS and signing run through PSA Crypto in the secure world. That is encryption at rest, not isolation: the TLS stack reads the device key into non-secure memory at each connection (see [Known limits](#known-limits)). |
| TLS everywhere, forward secrecy, authenticated encryption | MQTT with mutual TLS on port 8883 and HTTPS for the download. The firmware offers only ECDHE suites, so every session has forward secrecy. It sets no narrower list, so it also offers CCM and CBC suites next to AES-GCM, and the server chooses (see [Known limits](#known-limits)). The bucket refuses plain HTTP. |
| Least privilege | Met for the boards and the console. The device policy is limited to the board's own topics. The console's roles have no delete, publish, signing or certificate rights. Not met for the operator: deployment and the bench run as the AWS root user (see [Known limits](#known-limits)). |
| Secure update: safe failure, no rollback to old firmware | Partly met. Over the air: trial boot with automatic revert; version checks in the console and the application, and in MCUboot for a test or permanent swap; user consent on the board. A revert skips MCUboot's check, and code in the application can forge one. Serial recovery has no version check and no trial, and a golden image restore goes back to the frozen image on purpose (see [Known limits](#known-limits)). |
| No default or shared passwords, two-factor sign-in | Administrator-created accounts with a temporary password and a required authenticator code. |
| Log security-relevant actions, never secrets | An audit entry for every attempted change that reaches the API function. A request that API Gateway's token check refuses appears only in the access log. An entry that cannot be stored is lost, and if the change itself succeeded the caller gets `audit_failed`. IAM lets the API's role only put and query entries, so it cannot delete or update one. A put could still replace an entry with the same key, and IAM cannot forbid that: the code sends a condition on every put that refuses it. To notice a rewrite, the function logs a digest of each entry, which the role cannot change, and `cloud/api/verify-audit.mjs` compares the two for the 90 days the log keeps its lines. Access log without query strings; no tokens, links or request bodies in any log. |
| Only the servers a device needs | The board talks to its AWS IoT endpoint and downloads from one bucket prefix. |

### Known limits

Stated plainly. What has been measured, and on which firmware, is in the
[test results](test-results.md), and so is
[whether the over-the-air regression on the final firmware has run](test-results.md#over-the-air-on-the-final-firmware).

- The board speaks TLS 1.2; TLS 1.3 is not enabled in this build.
- MCUboot's image encryption is off, so images are stored in the clear in external flash. S3
  encrypts them at rest, but anyone with a download link gets the plain image. An image contains
  no secrets, but it can be copied by someone who holds the board.
- The signing key is a file on the release builder's machine, and every build uses it, including
  test images with a fault built in. The disk is encrypted (FileVault), which protects a machine
  that is off, not a running one. Moving the key into AWS KMS
  (sign with `imgtool --vector-to-sign`, `aws kms sign`, `imgtool --fix-sig`) would mean
  no person holds it at all.
- Downgrade protection is by version comparison in MCUboot, not by a hardware counter.
- A compromised application can get round that comparison. MCUboot makes it before a test or permanent
  swap, and skips it for a revert (`check_downgrade_prevention()` in `loader.c`). The application can
  write the primary slot's trailer, so it can forge a revert and swap in any older signed image it has
  put in the secondary slot. On a board with a golden image it has one in external flash, with no
  network needed. It cannot run unsigned code this way. This was read from source and not run.
- MCUboot does not check the image number in a serial recovery upload, and uses it as an index,
  so an upload could erase and write other flash areas, the bootloader's own among them.
  `CONFIG_BOOT_FLASH_AREA_HOOKS` and `image_number_guard.c` refuse every number but 0. A board keeps the
  hole until its bootloader is flashed over the debug port, since MCUboot is not updated over the air.
  On the frozen bootloader, bench test G14 sent numbers 1 and 3 and both were refused. It does not send
  the numbers that reach those other areas, so the hole itself comes from reading the source.
- Serial recovery has no version check. It writes straight into the primary slot, and the next
  boot checks the signature only, so any image ever signed with this key can be installed over
  a newer one, with no trial and no revert. No button is needed, because the bootloader also takes
  a command in the half second after a reset. Today this adds no power, because the debug port is
  open. Entry with `--reset`, with `--console` and with no valid image was tested on the board. Entry
  with Button 1 is not tested on hardware yet.
- The development kit's debug port is open. A product build would have to lock it (APPROTECT) and
  leave out the serial console (`-Dapp_CONFIG_APP_CONSOLE=n`). This repository has no such build yet.
- A product build should also narrow serial recovery. Dropping `CONFIG_BOOT_SERIAL_WAIT_FOR_DFU` means
  a board with a valid image needs Button 1. Button 1 and the no-valid-image state still take any
  image signed with this key. Building MCUboot without `CONFIG_MCUBOOT_SERIAL` removes the path. A
  version check is an open design: `boot_serial_uploaded_hook` runs after the old image has been
  overwritten, so the old version would have to be stored elsewhere, and a refusal at that point
  leaves no image. `CONFIG_BOOT_IMAGE_ACCESS_HOOKS` is off in this build. None of this is tested.
- MCUboot does not check the network core's image. It is flashed over the debug port. It has
  no radio stack and no keys.
- The board's device key is not isolated from the application. It is generated on the board and
  never leaves it, and TF-M stores it encrypted. But it is created as exportable and stored as
  an ordinary Protected Storage item, each TLS setup reads it into the non-secure heap, and that
  buffer is freed without being wiped. Code running in the non-secure application could read it
  and act as that board until its certificate is retired. It could not reach other boards or get
  unsigned firmware accepted. A real fix needs a non-exportable PSA key used as an opaque key, and
  this SDK's socket TLS layer shows no way to pass one.
- The firmware sets no cipher list. It offers the 16 non-PSK suites compiled in, all ECDHE: 4
  with GCM, 4 with CCM (2 of them CCM-8) and 8 with CBC (4 of them with HMAC-SHA1). The server
  chooses, and TLS's Finished check stops a network attacker from forcing a weaker choice. The
  handshake was not captured, so this document does not say which suite AWS picks.
- The audit log shows what reached the API function. A rewrite of an entry can be detected only
  while the log keeps its digest (90 days). Entries stored before the digest code was deployed have
  no digest and cannot be checked. The role could still add false entries and false lines: this
  detects changes to what was recorded, not lies told by the function. An AWS administrator can do
  anything to the table, and the CloudTrail record does not cover items in it.
- The CloudTrail record starts when `cloud/trail.sh` first runs, so it shows nothing older. It holds
  management events only, so it does not show a function being invoked or an image being stored.
- Deployment, `cloud/users.sh`, provisioning and the hardware bench run as the AWS account's root
  user. Root has MFA on and no access keys (confirmed from AWS on 2026-10-31). But a signed-in session
  lasts up to 12 hours and has full rights. The least-privilege row above covers the boards and the
  console's roles, not the operator. These jobs should move to an IAM user or to IAM Identity Center
  (SSO), with root kept for account-level tasks.
- `scripts/ota.sh` and `firmware/tests/hil/ota_bench.py` invoke the API function directly, with
  `aws lambda invoke` and hand-written token claims. This bypasses API Gateway and sign-in: no token
  check, no password, no authenticator code, no request limit and no line in the access log. The
  function trusts the claims, because it expects API Gateway to have checked them. It still asks
  Cognito whether the named person is an active release manager, runs its upload checks and writes
  an audit entry in that person's name. So an audit entry does not prove that the person signed in.
  The bench's request IDs start with `bench-`, but a caller could change that. Doing this takes AWS
  rights to invoke the function, which only an AWS administrator has. The update to 1.2.0 went this
  way.
- The hardware bench works on the production stack. Its `cranium-bench-…` jobs and the images it
  stores directly leave no audit entry.
- Sign-in can be blocked from outside. Cognito locks an account for a while after repeated wrong
  passwords, and the attempts need no credential. Sign-in names are e-mail addresses, so anyone who
  knows an address can keep that person from signing in. This comes from AWS's documentation and was
  not tested here. Recovery: add an account at another address with `cloud/users.sh`, or use the AWS
  CLI stop in `cloud/README.md`.
- API Gateway checks a token offline, so signing out does not end a copy of the token: it works
  for reading and writing until it expires, at most 60 minutes. A removed or disabled user cannot
  write, and reads for at most another minute. During a Cognito outage such a user may read
  until the token expires.
- The signature is ECDSA P-256, by the team's decision. Ed25519 is the possible later upgrade, and
  it needs a bootloader reflash over the debug port. Post-quantum signatures are not available in
  this MCUboot.
- Not every answer carries the site's security headers. A request to `/api/` with no valid token is
  refused by API Gateway's authorizer, and its 401 has no `strict-transport-security`, `nosniff` or
  content security policy. An HTTP API cannot change that. The same goes for a 429 and for the other
  answers listed under
  [What the gateway answers itself](../cloud/README.md#what-the-gateway-answers-itself). These answers
  are not pages, and nothing renders them.
- Plain HTTP does not redirect. Nothing in the stack listens on port 80: API Gateway takes HTTPS only,
  and the names are "DNS only" at Cloudflare, so nothing sits in front of it. A plain `curl` to
  `http://console.craniumiot.com/` failed to connect when this was tried on 2026-10-31, and the home
  page's names, which work the same way, were not tried. So someone who types `http://` gets a browser
  error, unless the browser tries HTTPS by itself or has been here before and remembers
  `Strict-Transport-Security`. On a first visit on a hostile network, an attacker could answer on port
  80 instead. The invitation mail links to the `https://` address.
- The home page's names are not a separate site. The stack maps them to the same API and stage as the
  console's name, so `/api/me` on the home host is the console's API, behind the same token check. With
  no token it gets the same 401 from the gateway. The web function's 404 for that path, which
  `cloud/web/test/home.test.mjs` checks, is not what a `GET` there meets, because the API's route claims
  it first. No page on those names calls the API, and a token is good for nothing there that it was not
  good for already. This is from `cloud/infra/template.yaml`, and was not tried on the deployed home
  page.

## Threat model

What is worth protecting: the signing key, each board's device key, the Wi-Fi credentials, the
console accounts and the audit log. Firmware images hold no secrets.

| Who | What stops them | What is accepted |
| --- | --- | --- |
| Someone on the network path | TLS with verified certificates on every connection, and signed images. | They can block traffic. An update then waits or fails, and nothing is installed. |
| Someone on the internet, with no account | Sign-in with a password and an authenticator code. Uploads need a valid signature. | A flood can use up the API's shared request limit, because an HTTP API has no per-caller limit. Wrong passwords against a known address can keep that person from signing in. The AWS CLI stop still works in both cases, and an administrator can add an account at another address. |
| A stolen release-manager session | The console cannot sign. Boards verify with their own key, refuse older versions and wait for Button 1. | Until the token expires they can deploy existing releases, cancel and revoke. |
| A break-in at the API function | The same: the function cannot sign, and boards make the same checks. | Until the code is replaced it holds the API role, with no token limit. It can create jobs, cancel, revoke and add false audit entries. |
| Code running in the application on one board | MCUboot refuses unsigned firmware. Other boards are out of reach. The pin in the bootloader keeps any other image from being restored as the golden one. | That board's device key can be read. Retire its certificate. It can forge a revert to an older signed image, the golden image among them, and it can erase the golden copy (see [Known limits](#known-limits)). |
| Someone holding a development kit | Nothing yet: the debug port is open. | They can read or replace anything on that board, and Button 2 takes it back to the golden image and its known flaws. A product build would have to lock the port. This repository has no such build yet. |
| Someone with the signing key | Nothing on the boards, which would accept the image. Over the air, Button 1 is still needed. With access to the UART, serial recovery takes the image with no button. | The key is a file on the builder's machine. Replacing it means reflashing boards and freezing a new golden image. The pin keeps the golden copy itself from being replaced with the key alone. |
| An AWS administrator | Nothing in the cloud. The CloudTrail record (`cloud/trail.sh`) and the audit digests show many changes afterwards. | They can change anything in the cloud, and can act in the console as any active release manager by invoking the API function. They cannot sign firmware without the key. Today this is the root user (see [Known limits](#known-limits)). |

## Cost

Everything is pay-per-use and, for four boards and four users, comes to well under one
US dollar a month: a board's one-minute report is about 45,000 messages a month, and the
console's functions and tables see a few thousand requests. The `cranium-budget` stack
sends an e-mail when the monthly cost passes its thresholds.
