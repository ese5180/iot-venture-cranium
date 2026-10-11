# Cranium firmware console: cloud

The update server for the Cranium boards. The team uploads a signed firmware image in a
web console, sees its version, deploys it to boards and watches each board update. The
console only verifies signatures: it holds the public half of the signing key and can
never sign anything.

It is two CloudFormation stacks, deployed with the AWS CLI:

- `cranium-ota-bootstrap` (`infra/bootstrap.yaml`): the bucket that the Lambda code is
  uploaded to.
- `cranium-ota` (`infra/template.yaml`): everything else.
  - An HTTP API with two Lambda functions: one serves the console, one is its API.
  - A Cognito user pool for sign-in. Accounts are created by an administrator, and
    every sign-in needs a password and a code from an authenticator app.
  - A bucket for firmware images. An image is written once and never overwritten.
  - Two DynamoDB tables: the releases and the audit log.
  - In AWS IoT: the thing group `cranium-devices`, the device policy `cranium-device`,
    and the role AWS IoT Jobs uses to sign short-lived download links.

No file here holds an account ID, an endpoint, a secret or an e-mail address. What a
deployment produces is written to `cloud/.deploy/`, which git ignores.

## Before you start

- AWS CLI v2 with a signed-in profile, Node.js 22, `openssl` and `curl`.
- `export AWS_PROFILE=<profile>`. The Region comes from `AWS_REGION` and is `us-east-1`
  if that is not set. Every script here uses these two and can be run from any directory.
- The public half of the firmware signing key in `firmware/keys/fw_signing_pub.pem`.

## Deploy

```sh
cloud/deploy.sh
```

It runs the tests, creates or updates both stacks, writes the stack outputs to
`cloud/.deploy/outputs.json` (the board provisioning tool reads that file) and prints
the address of the console. A first deployment takes a few minutes. Run it again after
any change: it only changes what differs.

- The user pool is created without deletion protection, so that a failed first
  deployment can clean up after itself. The same run switches the protection on once
  the stack exists.
- The stack switches on AWS IoT logging, which is one setting per account and Region.
  If it is already on, the script stops and says how to hand it over. AWS IoT logs to
  the group `AWSIotLogsV2`, which belongs to the account and not to the stack: the
  script creates it if it is missing and gives it a retention period of 90 days if it
  has none.
- The console accepts only images signed with the key in
  `firmware/keys/fw_signing_pub.pem`. Once the console is deployed, a run that finds
  another key in that file stops and shows both fingerprints. If the project's key was
  replaced on purpose, run `cloud/deploy.sh --replace-signing-key`.
- Sign-in names are not case sensitive. That is fixed when the user pool is created: a
  pool from an earlier version of this stack compares addresses exactly, and the script
  says so when it updates one. Users of such a pool type their address in lower case.
- Template parameters can be given as arguments, for example
  `cloud/deploy.sh IotLogLevel=DEBUG`. See `cloud/deploy.sh --help`.

## Add users

```sh
cloud/users.sh add <email> release-manager    # or: viewer
cloud/users.sh list
cloud/users.sh resend <email>                 # the invitation expired or got lost
cloud/users.sh reset-mfa <email>              # new phone, lost authenticator app
cloud/users.sh remove <email>
```

A release manager may upload and revoke firmware and create and cancel deployments. A
viewer may only look. `add` on an existing account changes its role. An address is
always stored in lower case, however it is typed.

Cognito sends the new user a temporary password that is valid for three days. At the
first sign-in the user chooses a password and registers an authenticator app. Nobody
can sign up or reset a password alone: for a forgotten password, remove the account and
add it again. A session lasts 60 minutes, then the console asks to sign in again.

Whether a user may change something is asked of Cognito for every change. Removing a
user, or giving or taking away the release manager role, therefore counts at once. What
a browser that is still signed in shows follows at the next sign-in: until then it
keeps reading, and it shows the controls of the old role.

## Check and watch

```sh
cloud/smoke.sh          # the console answers, the API refuses anonymous calls, the
                        # sign-in page loads, the API function can reach its data
cloud/logs.sh api       # or: web, access, iot
```

| What you see | Where to look |
| --- | --- |
| The console says you are not signed in, or a request answers 401 | `logs.sh access`: `authorizerError` says why the token was refused |
| A request answers 500 | `logs.sh api`, with the `requestId` from the error message |
| A 500 with no line in the API log | `logs.sh access`: `integrationError` |
| A board does not come online | `logs.sh iot`: look for `Connect` entries with status `Failure`. The client ID must be the thing name, and the certificate must be attached to the thing |
| A board refuses or fails an update | the deployment page of the console, then the board's serial console |
| A revocation answers that it is not complete, or a release shows as not completely revoked | Revoke it again. The release is marked, so nothing new can start; blocking the image or cancelling a deployment did not go through, or a board is still at work that could not be stopped (see below). The answer says which |

Search the access log with text patterns, for example
`cloud/logs.sh access --filter-pattern '"invalid_token"'`. API Gateway cannot escape
its own error messages, so a line that carries one is not always valid JSON, and a
JSON pattern such as `{ $.status = "401" }` passes those lines over. The two messages,
`integrationError` and `authorizerError`, come last in a line; everything before them
can be relied on.

A connection that fails authentication (a certificate AWS IoT does not know, or an
inactive one) is logged as well: the stack switches on the event type
`Connection.AuthNError`, which is off by default. Such a connection needs no
credential, so anyone who knows the endpoint can add entries to that log. They cost a
little each and expire with the retention period of the log group `AWSIotLogsV2`
(90 days unless you chose another).

### Stop an update without the console

The console's API has one request limit for all its users. If it answers 429 to
everybody, or cannot be reached, an update can still be stopped with the AWS CLI.
The bucket name is `FirmwareBucketName` in `cloud/.deploy/outputs.json`; the digest is
shown with the release on the Firmware page, and `aws iot list-jobs` lists the
deployments.

```sh
# 1. Block the image: the bucket refuses every download of a tagged object at once.
aws s3api put-object-tagging --bucket <FirmwareBucketName> \
  --key firmware/<sha256 of the image>.bin --tagging 'TagSet=[{Key=revoked,Value=true}]'
# 2. Stop the boards that have started.
aws iot cancel-job --job-id <deployment id> --force --reason-code RELEASE_REVOKED
```

Then revoke the release in the console as soon as it answers again, so that it cannot
be deployed any more.

### A board at work on a cancelled deployment

Cancelling a deployment without force leaves a board that had started alone, and the
deployment then counts as cancelled in AWS. What a second, forced cancellation does to
such a deployment, AWS does not document, and it is what the console sends when you
cancel with force or revoke the release afterwards. Measured in October 2026, AWS
accepts it and stops the board 5 to 15 seconds later. The console does not assume that:
it reads the board's state back, answers that the cancellation was refused or that the
revocation is not complete while a board is still at work, and shows the release as
such until no board is left. Asking again a few seconds later then completes it. A board in that state can no longer download a revoked image, and AWS ends its
part in the deployment 30 minutes after it started. To stop it at once:

```sh
aws iot cancel-job-execution --job-id <deployment id> --thing-name <board> --force
```

Then revoke the release again; it completes. The role of the API function may not
cancel a single board's part in a job, so the console cannot do this itself. What AWS
did with the second cancellation is in the API log (`cloud/logs.sh api`): `cancel_refused`
if it refused, `cancel_unconfirmed` if it accepted and the board was still at work.

## Tear down

```sh
cloud/teardown.sh
```

After you have typed the stack name, it removes everything: the jobs, the boards'
things and certificates, both stacks, and also what the stack keeps on purpose when it
is deleted (the user pool with its accounts, the firmware bucket with every image, the
two tables). It can be run again if it stops halfway. Boards have to be provisioned
again after a new deployment.

It leaves two things alone: the budget stack (`infra/budget.yaml`, a monthly cost alert
that is deployed on its own) and the log group `AWSIotLogsV2`, which belongs to AWS IoT
in this account and not to the stack. Its entries expire with its retention period.

## Try it without AWS

```sh
node cloud/dev/preview.mjs --scenario waiting-for-button    # --help lists the scenarios
```

A local preview on `127.0.0.1`: the real console and the real API, with an in-memory
stand-in for AWS, an emulated sign-in without a password, and simulated boards. It talks
to nothing outside this computer, shows no real data, and is never deployed. Add `--live`
to let the boards act and press their buttons from the terminal, or `--viewer` to see the
console as a viewer does.

The stand-in refuses a forced cancellation of a deployment that is cancelled already
(see "A board at work on a cancelled deployment" above). `--repeated-cancel accepted`
and `--repeated-cancel ignored` show the console in the two other cases that AWS could
turn out to be.

## Layout

```
deploy.sh  users.sh  smoke.sh  logs.sh  teardown.sh
infra/bootstrap.yaml   the artifacts bucket
infra/template.yaml    the console: API, sign-in, storage, AWS IoT
infra/budget.yaml      cost alert, separate stack
api/                   the API function (src/) and its tests (test/)
web/                   the function that serves the console (src/) and its tests (test/)
dev/                   local preview and its tests, never deployed
```

The tests need neither AWS nor any package: `node --test` in `cloud/api`, in `cloud/web`
and in `cloud/dev`. Those in `cloud/dev` run the console's own client against the real
API handler, so they notice when the two stop agreeing.
