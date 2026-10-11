#!/usr/bin/env bash
#
# Deploy the Cranium firmware console, or update it. Safe to run again at any time.
#
#   AWS_PROFILE=<profile> cloud/deploy.sh [Parameter=Value ...]
#
# The profile and the Region come from AWS_PROFILE and AWS_REGION (default us-east-1).
# Optional arguments set template parameters: SlotSize, LoadAddress, IotLogLevel and
# UserPoolDeletionProtection. A parameter that is not given keeps its current value.
#
# Needs the AWS CLI v2, Node.js 22 and openssl. Everything this script writes goes to
# cloud/.deploy/, which git ignores.

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$CLOUD_DIR")"
DEPLOY_DIR="$CLOUD_DIR/.deploy"
SIGNING_KEY_FILE="$REPO_DIR/firmware/keys/fw_signing_pub.pem"
BOOTSTRAP_STACK=cranium-ota-bootstrap
STACK=cranium-ota
WORK=""

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""

# die <message> [further lines ...]
die() {
  printf 'error: %s\n' "$1" >&2
  shift
  if [ $# -gt 0 ]; then
    printf '       %s\n' "$@" >&2
  fi
  exit 1
}

step() {
  printf '\n== %s\n' "$*"
}

# The comment block at the top of this file.
usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

check_tools() {
  local version major
  command -v aws > /dev/null || die "the AWS CLI is not installed"
  version="$(aws --version 2>&1)"
  case "$version" in
    aws-cli/2.*) ;;
    *) die "the AWS CLI v2 is needed (found: $version)" ;;
  esac
  command -v node > /dev/null || die "Node.js is not installed"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node.js 22 or newer is needed (found $(node --version))"
  command -v openssl > /dev/null || die "openssl is not installed"
  command -v base64 > /dev/null || die "base64 is not installed"
}

# Things that would otherwise fail halfway through, checked before anything changes.
check_sources() {
  local entry unreadable
  [ -f "$SIGNING_KEY_FILE" ] || die "firmware/keys/fw_signing_pub.pem is missing"
  # The file is committed to a public repository and becomes a stack parameter: it
  # may hold the public half only.
  if grep -q 'PRIVATE KEY' "$SIGNING_KEY_FILE"; then
    die "firmware/keys/fw_signing_pub.pem contains a PRIVATE key." \
      "Only the public half belongs there. Treat that key as exposed and replace it."
  fi
  for entry in api/src/index.mjs web/src/server.mjs; do
    [ -f "$CLOUD_DIR/$entry" ] || die "cloud/$entry is missing"
  done
  # The package keeps each file's permission bits, and Lambda reads the code as
  # another user: a file that only its owner can read fails when the function starts.
  unreadable="$(find "$CLOUD_DIR/api/src" "$CLOUD_DIR/web/src" -type f ! -perm -004)"
  if [ -n "$unreadable" ]; then
    printf '%s\n' "$unreadable" >&2
    die "the files above are not readable by others; run chmod a+r on them"
  fi
}

# run_tests <api|web>. "node --test" succeeds when it finds no tests at all, so their
# presence is checked first.
run_tests() {
  ls "$CLOUD_DIR/$1/test"/*.test.mjs > /dev/null 2>&1 || die "cloud/$1/test holds no tests"
  (cd "$CLOUD_DIR/$1" && node --test) || die "the $1 tests failed; nothing was deployed"
}

# Prints the status of a stack, or NONE when it does not exist.
stack_status() {
  local out
  if out="$(aws cloudformation describe-stacks --stack-name "$1" \
      --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    printf '%s\n' "$out"
    return 0
  fi
  case "$out" in
    *"does not exist"*)
      printf 'NONE\n'
      ;;
    *)
      printf '%s\n' "$out" >&2
      return 1
      ;;
  esac
}

# stack_output <stack> <output key>
stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text
}

# stack_parameter <stack> <parameter key>
stack_parameter() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Parameters[?ParameterKey=='$2'].ParameterValue | [0]" --output text
}

# Make sure the stack can be created or updated. A stack whose first creation failed
# stays in ROLLBACK_COMPLETE: it holds nothing and cannot be updated, so it is deleted.
prepare_stack() {
  local stack="$1" status
  status="$(stack_status "$stack")"
  case "$status" in
    NONE|REVIEW_IN_PROGRESS|CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)
      ;;
    ROLLBACK_COMPLETE)
      echo "$stack is left over from a failed creation and is empty; deleting it"
      aws cloudformation delete-stack --stack-name "$stack"
      aws cloudformation wait stack-delete-complete --stack-name "$stack"
      ;;
    UPDATE_ROLLBACK_FAILED)
      die "$stack is in $status. Let CloudFormation finish the rollback, then run this again:" \
        "aws cloudformation continue-update-rollback --stack-name $stack"
      ;;
    ROLLBACK_FAILED|DELETE_FAILED)
      die "$stack is in $status. See what could not be removed, delete the stack, then run this again:" \
        "aws cloudformation describe-stack-events --stack-name $stack" \
        "aws cloudformation delete-stack --stack-name $stack"
      ;;
    *_IN_PROGRESS)
      die "$stack is busy ($status). Wait until it has finished and run this again."
      ;;
    *)
      die "$stack is in an unexpected state: $status"
      ;;
  esac
}

show_failures() {
  echo "What failed in $1, newest first:" >&2
  aws cloudformation describe-stack-events --stack-name "$1" --max-items 100 \
    --query "StackEvents[?ends_with(ResourceStatus, '_FAILED')].[LogicalResourceId, ResourceStatusReason]" \
    --output text >&2 || true
}

# deploy_stack <stack> <template file> [options of "aws cloudformation deploy" ...]
deploy_stack() {
  local stack="$1" template="$2"
  shift 2
  if ! aws cloudformation deploy --stack-name "$stack" --template-file "$template" \
      --no-fail-on-empty-changeset "$@"; then
    show_failures "$stack"
    die "$stack was not deployed"
  fi
}

# The signing public key in the form the stack takes: base64 of the DER
# SubjectPublicKeyInfo on one line.
signing_public_key() {
  local key
  key="$(openssl pkey -pubin -in "$SIGNING_KEY_FILE" -outform DER | base64 | tr -d '\r\n')" ||
    die "firmware/keys/fw_signing_pub.pem is not a public key in PEM form"
  # Every uncompressed ECDSA P-256 public key starts with the same 27 bytes of DER
  # (36 base64 characters); the two 32-byte coordinates follow. Nothing else fits,
  # in particular no private key and no key of another type.
  if [[ ! "$key" =~ ^MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE[A-Za-z0-9+/]{86}==$ ]]; then
    die "firmware/keys/fw_signing_pub.pem is not an ECDSA P-256 public key"
  fi
  printf '%s\n' "$key"
}

# SHA-256 of the DER public key: what the console shows as the key fingerprint.
signing_key_fingerprint() {
  openssl pkey -pubin -in "$SIGNING_KEY_FILE" -outform DER | openssl dgst -sha256 -hex |
    awk '{ print $NF }'
}

# AWS IoT logging is one setting per account and Region. CloudFormation refuses to
# create it when it is already switched on, and the whole stack would roll back.
check_iot_logging_is_free() {
  local disabled
  if disabled="$(aws iot get-v2-logging-options --query disableAllLogs --output text 2> /dev/null)" &&
      [ "$disabled" = False ]; then
    die "AWS IoT logging is already switched on in this account and Region, outside this stack." \
      "The stack cannot take over an existing setting. Look at it with:" \
      "  aws iot get-v2-logging-options" \
      "If nothing else depends on it, switch it off and run this again; the stack then sets it up:" \
      "  aws iot set-v2-logging-options --disable-all-logs"
  fi
}

# All stack outputs as one flat JSON object, plus the AWS IoT data endpoint.
write_outputs() {
  local outputs endpoint
  outputs="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query 'Stacks[0].Outputs' --output json)"
  endpoint="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS \
    --query endpointAddress --output text)"
  printf '%s' "$outputs" | IOT_ENDPOINT="$endpoint" node -e '
    const flat = {};
    for (const { OutputKey, OutputValue } of JSON.parse(require("node:fs").readFileSync(0, "utf8"))) {
      flat[OutputKey] = OutputValue;
    }
    flat.IotEndpoint = process.env.IOT_ENDPOINT;
    process.stdout.write(JSON.stringify(flat, null, 2) + "\n");
  ' > "$DEPLOY_DIR/outputs.json.tmp"
  mv "$DEPLOY_DIR/outputs.json.tmp" "$DEPLOY_DIR/outputs.json"
}

main() {
  local arg requested_protection=""
  local extra=()
  for arg in "$@"; do
    case "$arg" in
      -h|--help)
        usage
        exit 0
        ;;
      UserPoolDeletionProtection=ACTIVE|UserPoolDeletionProtection=INACTIVE)
        requested_protection="${arg#*=}"
        extra+=("$arg")
        ;;
      SlotSize=*|LoadAddress=*|IotLogLevel=*)
        extra+=("$arg")
        ;;
      *)
        # Refused here: "aws cloudformation deploy" silently ignores unknown names.
        die "unknown argument: $arg" "Run cloud/deploy.sh --help for the parameters."
        ;;
    esac
  done

  check_tools
  check_sources

  step "1/9 Account"
  local identity account caller limit
  identity="$(aws sts get-caller-identity --query '[Account, Arn]' --output text)" ||
    die "no usable AWS credentials; set AWS_PROFILE to a signed-in profile"
  account="${identity%%$'\t'*}"
  caller="${identity#*$'\t'}"
  echo "Account $account, Region $AWS_REGION, signed in as $caller"
  case "$caller" in
    *:root)
      echo "Note: this is the root user of the account. It works, but an IAM Identity Center"
      echo "user or an IAM role is the safer habit."
      ;;
  esac
  limit="$(aws lambda get-account-settings \
    --query 'AccountLimit.ConcurrentExecutions' --output text)"
  echo "Lambda concurrent executions limit: $limit"
  if [[ "$limit" =~ ^[0-9]+$ ]] && [ "$limit" -lt 50 ]; then
    echo "Note: that is the reduced limit of a new account. If the console answers 429 or 503"
    echo "when several people open it at once, ask for a higher \"Concurrent executions\" quota"
    echo "for Lambda in Service Quotas. Do not reserve concurrency for the functions."
  fi

  step "2/9 Tests"
  run_tests api
  run_tests web

  umask 077
  mkdir -p "$DEPLOY_DIR"
  WORK="$(mktemp -d "$DEPLOY_DIR/deploy.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  # The CLI builds the zip files and a copy of the template in its temporary
  # directory: keep that inside .deploy as well.
  export TMPDIR="$WORK"

  step "3/9 Bootstrap stack ($BOOTSTRAP_STACK)"
  local artifacts_bucket
  prepare_stack "$BOOTSTRAP_STACK"
  deploy_stack "$BOOTSTRAP_STACK" "$CLOUD_DIR/infra/bootstrap.yaml"
  artifacts_bucket="$(stack_output "$BOOTSTRAP_STACK" ArtifactsBucketName)"
  case "$artifacts_bucket" in
    ""|None) die "$BOOTSTRAP_STACK has no ArtifactsBucketName output" ;;
  esac

  step "4/9 Signing public key"
  local signing_key
  signing_key="$(signing_public_key)"
  echo "SHA-256 fingerprint: $(signing_key_fingerprint)"
  echo "The Firmware page of the console shows the same fingerprint."

  step "5/9 State of $STACK"
  local status
  # Parameters that only a first deployment sets.
  local creation=()
  prepare_stack "$STACK"
  status="$(stack_status "$STACK")"
  case "$status" in
    NONE|REVIEW_IN_PROGRESS)
      echo "Not deployed yet; it will be created"
      # Fixed for the life of the user pool, so it is chosen here and never again.
      creation=(SignInNamesCaseSensitive=false)
      if [ "$requested_protection" = ACTIVE ]; then
        die "UserPoolDeletionProtection=ACTIVE cannot be given for the first deployment:" \
          "a protected pool could not be removed if the creation failed. Leave it out;" \
          "the protection is switched on as soon as the stack exists."
      fi
      check_iot_logging_is_free
      ;;
    *)
      echo "$status; it will be updated"
      ;;
  esac

  step "6/9 Package and deploy $STACK"
  aws cloudformation package \
    --template-file "$CLOUD_DIR/infra/template.yaml" \
    --s3-bucket "$artifacts_bucket" --s3-prefix "$STACK" \
    --output-template-file "$DEPLOY_DIR/packaged.yaml" > /dev/null
  local overrides=("SigningPublicKey=$signing_key" ${creation[@]+"${creation[@]}"} ${extra[@]+"${extra[@]}"})
  deploy_stack "$STACK" "$DEPLOY_DIR/packaged.yaml" \
    --s3-bucket "$artifacts_bucket" --s3-prefix "$STACK" \
    --capabilities CAPABILITY_IAM --parameter-overrides "${overrides[@]}"

  step "7/9 Outputs"
  write_outputs
  echo "Wrote cloud/.deploy/outputs.json"

  step "8/9 User pool deletion protection"
  # The stack is created with the protection off, because a protected pool cannot be
  # removed when a first creation fails and rolls back. Once the stack exists the
  # protection is switched on, unless this run asked for a value itself.
  if [ -n "$requested_protection" ]; then
    echo "$requested_protection, as requested on the command line"
  elif [ "$(stack_parameter "$STACK" UserPoolDeletionProtection)" = ACTIVE ]; then
    echo "ACTIVE"
  else
    echo "Switching it on"
    deploy_stack "$STACK" "$DEPLOY_DIR/packaged.yaml" \
      --s3-bucket "$artifacts_bucket" --s3-prefix "$STACK" \
      --capabilities CAPABILITY_IAM \
      --parameter-overrides "${overrides[@]}" UserPoolDeletionProtection=ACTIVE
  fi

  step "9/9 Done"
  echo "Console: $(stack_output "$STACK" ConsoleUrl)"
  echo
  echo "Next steps"
  echo "  1. Give yourself an account:  cloud/users.sh add <your e-mail> release-manager"
  echo "  2. Check the deployment:      cloud/smoke.sh"
  echo "  3. Provision a board:         python3 tools/provision_device.py"
  echo "  4. Watch what happens:        cloud/logs.sh api      (or web, access, iot)"
}

main "$@"
