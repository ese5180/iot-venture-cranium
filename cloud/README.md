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
  If it is already on, the script stops and says how to hand it over.
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
viewer may only look. `add` on an existing account changes its role.

Cognito sends the new user a temporary password that is valid for three days. At the
first sign-in the user chooses a password and registers an authenticator app. Nobody
can sign up or reset a password alone: for a forgotten password, remove the account and
add it again. A session lasts 60 minutes, then the console asks to sign in again.

Removing a user, or taking away the release manager role, stops every change by that
user at once. A browser that is still signed in can keep reading for the rest of its
session.

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

AWS IoT does not log a connection that fails authentication (a certificate it does not
know, or an inactive one) unless the event type `Connection.AuthNError` is switched on
under *Logs* in the AWS IoT console. The log group `AWSIotLogsV2` appears with the first
entry. AWS IoT creates it itself, so it is not part of the stack and keeps its entries
until you give it a retention period.

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
that is deployed on its own) and the log group `AWSIotLogsV2`, which AWS IoT creates
itself.

## Layout

```
deploy.sh  users.sh  smoke.sh  logs.sh  teardown.sh
infra/bootstrap.yaml   the artifacts bucket
infra/template.yaml    the console: API, sign-in, storage, AWS IoT
infra/budget.yaml      cost alert, separate stack
api/                   the API function (src/) and its tests (test/)
web/                   the function that serves the console (src/) and its tests (test/)
dev/                   local preview, never deployed
```

The tests need neither AWS nor any package: `node --test` in `cloud/api` and in
`cloud/web`.
