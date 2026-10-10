#!/usr/bin/env bash
#
# Remove the Cranium firmware console and everything it stored. This cannot be undone.
#
#   AWS_PROFILE=<profile> cloud/teardown.sh
#
# After you have typed the stack name to confirm, it
#   1. cancels the cranium-* jobs in AWS IoT and deletes them,
#   2. detaches and deletes the boards' certificates and deletes their things,
#   3. empties the firmware bucket and the artifacts bucket, all versions,
#   4. turns off the deletion protection of the user pool,
#   5. deletes the stacks cranium-ota and cranium-ota-bootstrap,
#   6. deletes what the stack keeps on purpose: the user pool with its accounts, the
#      firmware bucket and the two tables.
#
# It can be run again if it stops halfway. Boards keep their key and certificate in
# flash, but AWS IoT no longer knows them: provision them again after a new deployment.
#
# Not touched: the budget stack (cloud/infra/budget.yaml) and the log group
# AWSIotLogsV2, which AWS IoT created itself.
#
# The profile and the Region come from AWS_PROFILE and AWS_REGION (default us-east-1).
# What it needs to remember between runs is kept in cloud/.deploy/.

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$CLOUD_DIR/.deploy"
STATE_FILE="$DEPLOY_DIR/teardown.state"
OUTPUTS_FILE="$DEPLOY_DIR/outputs.json"
BOOTSTRAP_STACK=cranium-ota-bootstrap
STACK=cranium-ota
DEVICE_POLICY=cranium-device
THING_PATTERN='^cranium-[0-9a-f]{16}$'

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""

# The resources that outlive the stacks. Read from the stacks while they exist and
# from the state file afterwards.
POOL=""
FIRMWARE_BUCKET=""
STATE_TABLE=""
AUDIT_TABLE=""
ARTIFACTS_BUCKET=""

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
  local version
  command -v aws > /dev/null || die "the AWS CLI is not installed"
  version="$(aws --version 2>&1)"
  case "$version" in
    aws-cli/2.*) ;;
    *) die "the AWS CLI v2 is needed (found: $version)" ;;
  esac
}

# retry <command ...>: AWS IoT applies a detachment with a delay, so a deletion that
# depends on it is tried a few times.
retry() {
  local attempt=1 out
  while ! out="$("$@" 2>&1 < /dev/null)"; do
    if [ "$attempt" -ge 6 ]; then
      printf '%s\n' "$out" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
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

# stack_output <stack> <output key>: prints the value, or nothing.
stack_output() {
  local value
  value="$(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2> /dev/null)" ||
    return 0
  [ "$value" = None ] || printf '%s\n' "$value"
}

# saved <key>: the value an earlier run of this script, or deploy.sh, wrote down.
saved() {
  local value=""
  if [ -f "$STATE_FILE" ]; then
    value="$(sed -n "s/^$1=//p" "$STATE_FILE")"
  fi
  if [ -z "$value" ] && [ -f "$OUTPUTS_FILE" ]; then
    value="$(sed -n "s/^ *\"$1\": *\"\([^\"]*\)\",\{0,1\}\$/\1/p" "$OUTPUTS_FILE")"
  fi
  printf '%s\n' "$value"
}

# resolve <stack> <output key>
resolve() {
  local value
  value="$(stack_output "$1" "$2")"
  [ -n "$value" ] || value="$(saved "$2")"
  printf '%s\n' "$value"
}

# check_name <what> <value> <pattern>: a name read from a file is not trusted blindly.
check_name() {
  if [ -n "$2" ] && [[ ! "$2" =~ $3 ]]; then
    die "the $1 recorded for this deployment does not look right: $2" \
      "Remove cloud/.deploy/teardown.state if it is damaged."
  fi
}

discover() {
  POOL="$(resolve "$STACK" UserPoolId)"
  FIRMWARE_BUCKET="$(resolve "$STACK" FirmwareBucketName)"
  STATE_TABLE="$(resolve "$STACK" StateTableName)"
  AUDIT_TABLE="$(resolve "$STACK" AuditTableName)"
  ARTIFACTS_BUCKET="$(resolve "$BOOTSTRAP_STACK" ArtifactsBucketName)"
  # CloudFormation derives these names from the stack name.
  check_name "user pool" "$POOL" '^[A-Za-z0-9-]+_[A-Za-z0-9]+$'
  check_name "firmware bucket" "$FIRMWARE_BUCKET" '^cranium-ota-[a-z0-9-]+$'
  check_name "release table" "$STATE_TABLE" '^cranium-ota-[A-Za-z0-9-]+$'
  check_name "audit table" "$AUDIT_TABLE" '^cranium-ota-[A-Za-z0-9-]+$'
  check_name "artifacts bucket" "$ARTIFACTS_BUCKET" '^cranium-ota-bootstrap-[a-z0-9-]+$'
}

save_state() {
  umask 077
  mkdir -p "$DEPLOY_DIR"
  {
    printf 'UserPoolId=%s\n' "$POOL"
    printf 'FirmwareBucketName=%s\n' "$FIRMWARE_BUCKET"
    printf 'StateTableName=%s\n' "$STATE_TABLE"
    printf 'AuditTableName=%s\n' "$AUDIT_TABLE"
    printf 'ArtifactsBucketName=%s\n' "$ARTIFACTS_BUCKET"
  } > "$STATE_FILE"
}

confirm() {
  local account answer
  account="$(aws sts get-caller-identity --query Account --output text)" ||
    die "no usable AWS credentials; set AWS_PROFILE to a signed-in profile"
  echo "This removes the Cranium firmware console from account $account, Region $AWS_REGION:"
  echo "  - the stacks $STACK ($(stack_status "$STACK")) and $BOOTSTRAP_STACK ($(stack_status "$BOOTSTRAP_STACK"))"
  echo "  - the user pool with every account: ${POOL:-not found}"
  echo "  - the firmware bucket with every stored image: ${FIRMWARE_BUCKET:-not found}"
  echo "  - the release table and the audit table: ${STATE_TABLE:-not found}, ${AUDIT_TABLE:-not found}"
  echo "  - every cranium-* job, and the thing and certificate of every board"
  echo "It cannot be undone."
  printf 'Type %s to confirm: ' "$STACK"
  read -r answer || answer=""
  [ "$answer" = "$STACK" ] || die "not confirmed; nothing was changed"
}

# delete_job <job id>
delete_job() {
  local job="$1" out waited=0
  if ! out="$(aws iot delete-job --job-id "$job" --force 2>&1 < /dev/null)"; then
    case "$out" in
      *ResourceNotFoundException*) return 0 ;;
    esac
    echo "  could not delete $job: $out" >&2
    return 0
  fi
  # AWS IoT deletes a job in the background and allows only a few at a time, so wait
  # for each one before starting the next.
  while aws iot describe-job --job-id "$job" > /dev/null 2>&1 < /dev/null; do
    if [ "$waited" -ge 120 ]; then
      echo "  $job is still being deleted; going on"
      return 0
    fi
    waited=$((waited + 3))
    sleep 3
  done
  echo "  deleted job $job"
}

remove_jobs() {
  local jobs job status
  jobs="$(aws iot list-jobs \
    --query "jobs[?starts_with(jobId, 'cranium-')].[jobId, status]" --output text)"
  case "$jobs" in
    ""|None)
      echo "  none"
      return 0
      ;;
  esac
  # Cancel everything first, so that a board that is online stops before its job
  # disappears. Force also stops executions that are already in progress.
  while IFS=$'\t' read -r job status; do
    case "$status" in
      IN_PROGRESS|SCHEDULED)
        if aws iot cancel-job --job-id "$job" --force --reason-code TEARDOWN \
            --comment "cloud/teardown.sh" > /dev/null < /dev/null; then
          echo "  cancelled job $job"
        else
          echo "  could not cancel job $job; it is deleted all the same" >&2
        fi
        ;;
    esac
  done <<< "$jobs"
  while IFS=$'\t' read -r job status; do
    [ -n "$job" ] || continue
    delete_job "$job"
  done <<< "$jobs"
}

# remove_certificate <certificate ARN>
remove_certificate() {
  local arn="$1" id="${1##*/}" things thing policies policy foreign=""
  things="$(aws iot list-principal-things --principal "$arn" --query things --output text)"
  for thing in $things; do
    if [ "$thing" != None ] && [[ ! "$thing" =~ $THING_PATTERN ]]; then
      foreign="$foreign $thing"
    fi
  done
  if [ -n "$foreign" ]; then
    # Not only ours: take the device policy off it, so that the policy can be
    # deleted, and leave the certificate alone.
    aws iot detach-policy --policy-name "$DEVICE_POLICY" --target "$arn" 2> /dev/null || true
    echo "  kept certificate ${id:0:12}...: it also belongs to$foreign"
    return 0
  fi
  policies="$(aws iot list-attached-policies --target "$arn" \
    --query 'policies[].policyName' --output text)"
  for policy in $policies; do
    [ "$policy" = None ] || aws iot detach-policy --policy-name "$policy" --target "$arn"
  done
  # A certificate that is already revoked cannot be made inactive but can be deleted;
  # one that is still active makes the deletion below fail, which stops the script.
  aws iot update-certificate --certificate-id "$id" --new-status INACTIVE || true
  retry aws iot delete-certificate --certificate-id "$id" --force-delete
  echo "  deleted certificate ${id:0:12}..."
}

remove_devices() {
  local all things thing principals principal targets certificate certificates=""
  all="$(aws iot list-things --query 'things[].thingName' --output text)"
  # Only names of the form this project gives its boards.
  things="$(printf '%s\n' "$all" | tr '\t' '\n' | grep -E "$THING_PATTERN" || true)"
  for thing in $things; do
    principals="$(aws iot list-thing-principals --thing-name "$thing" \
      --query principals --output text)"
    for principal in $principals; do
      [ "$principal" != None ] || continue
      aws iot detach-thing-principal --thing-name "$thing" --principal "$principal"
      certificates="$certificates $principal"
    done
    retry aws iot delete-thing --thing-name "$thing"
    echo "  deleted thing $thing"
  done
  # Certificates that carry the device policy without being attached to a thing, for
  # example after an interrupted provisioning run.
  if targets="$(aws iot list-targets-for-policy --policy-name "$DEVICE_POLICY" \
      --query targets --output text 2> /dev/null)"; then
    certificates="$certificates $targets"
  fi
  # One per line, each once. Unquoted on purpose: ARNs contain no spaces.
  certificates="$(printf '%s\n' $certificates | sort -u)"
  for certificate in $certificates; do
    case "$certificate" in
      arn:*:iot:*:cert/*) remove_certificate "$certificate" ;;
    esac
  done
  [ -n "$things$certificates" ] || echo "  none"
}

bucket_exists() {
  aws s3api head-bucket --bucket "$1" > /dev/null 2>&1
}

# empty_bucket <bucket>: delete every version of every object and every delete marker.
empty_bucket() {
  local bucket="$1" batch="$DEPLOY_DIR/teardown-batch.json" listing problem
  while :; do
    # One page of at most 500 entries, in the form "delete-objects" takes.
    listing="$(aws s3api list-object-versions --bucket "$bucket" --no-paginate --max-keys 500 \
      --query '{Objects: [Versions, DeleteMarkers][].{Key: Key, VersionId: VersionId}, Quiet: `true`}' \
      --output json)"
    case "$listing" in
      *'"Key"'*) ;;
      *) break ;;
    esac
    printf '%s\n' "$listing" > "$batch"
    problem="$(aws s3api delete-objects --bucket "$bucket" --delete "file://$batch" \
      --query 'Errors[0].[Key, Code]' --output text)"
    rm -f "$batch"
    case "$problem" in
      ""|None) ;;
      *) die "could not delete from $bucket: $problem" ;;
    esac
  done
}

# empty_bucket_if_present <what> <bucket>
empty_bucket_if_present() {
  if [ -z "$2" ]; then
    echo "  the $1 is not known; skipped"
  elif bucket_exists "$2"; then
    empty_bucket "$2"
    echo "  emptied the $1"
  else
    echo "  the $1 is already gone"
  fi
}

# The clean way, while the stack is healthy: through the stack parameter, which
# leaves every other setting of the pool as it is.
unprotect_user_pool() {
  local status current key keys
  local parameters=("ParameterKey=UserPoolDeletionProtection,ParameterValue=INACTIVE")
  status="$(stack_status "$STACK")"
  case "$status" in
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)
      ;;
    *)
      echo "  the stack is in state $status; the protection is turned off when the pool is deleted"
      return 0
      ;;
  esac
  current="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Parameters[?ParameterKey=='UserPoolDeletionProtection'].ParameterValue | [0]" \
    --output text)"
  if [ "$current" != ACTIVE ]; then
    echo "  already off"
    return 0
  fi
  keys="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query 'Stacks[0].Parameters[].ParameterKey' --output text)"
  for key in $keys; do
    [ "$key" = UserPoolDeletionProtection ] ||
      parameters+=("ParameterKey=$key,UsePreviousValue=true")
  done
  if aws cloudformation update-stack --stack-name "$STACK" --use-previous-template \
      --capabilities CAPABILITY_IAM --parameters "${parameters[@]}" > /dev/null &&
      aws cloudformation wait stack-update-complete --stack-name "$STACK"; then
    echo "  turned off"
  else
    echo "  could not be turned off through the stack; it is turned off when the pool is deleted"
  fi
}

# delete_stack <stack>. A device policy that was detached a moment ago can stay
# undeletable for up to five minutes, so a failed deletion is tried again.
delete_stack() {
  local stack="$1" attempt=1
  while [ "$attempt" -le 6 ]; do
    if [ "$(stack_status "$stack")" = NONE ]; then
      echo "  $stack is gone"
      return 0
    fi
    aws cloudformation delete-stack --stack-name "$stack"
    if aws cloudformation wait stack-delete-complete --stack-name "$stack" 2> /dev/null; then
      echo "  deleted $stack"
      return 0
    fi
    echo "  $stack is not deleted yet (attempt $attempt of 6); trying again in a minute"
    attempt=$((attempt + 1))
    sleep 60
  done
  aws cloudformation describe-stack-events --stack-name "$stack" --max-items 100 \
    --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId, ResourceStatusReason]" \
    --output text >&2 || true
  die "$stack could not be deleted; see the reasons above, then run this script again"
}

delete_user_pool() {
  local protection
  if [ -z "$POOL" ]; then
    echo "  the user pool is not known; skipped"
    return 0
  fi
  if ! protection="$(aws cognito-idp describe-user-pool --user-pool-id "$POOL" \
      --query 'UserPool.DeletionProtection' --output text 2>&1)"; then
    case "$protection" in
      *ResourceNotFoundException*)
        echo "  the user pool is already gone"
        return 0
        ;;
    esac
    die "$protection"
  fi
  if [ "$protection" = ACTIVE ]; then
    # This call resets every setting it does not name. That is acceptable only
    # because the pool is deleted in the next line and its app client is gone.
    aws cognito-idp update-user-pool --user-pool-id "$POOL" --deletion-protection INACTIVE
  fi
  aws cognito-idp delete-user-pool --user-pool-id "$POOL"
  echo "  deleted the user pool"
}

delete_firmware_bucket() {
  if [ -z "$FIRMWARE_BUCKET" ]; then
    echo "  the firmware bucket is not known; skipped"
  elif bucket_exists "$FIRMWARE_BUCKET"; then
    # Again: an upload may have arrived while the stack was still there.
    empty_bucket "$FIRMWARE_BUCKET"
    aws s3api delete-bucket --bucket "$FIRMWARE_BUCKET"
    echo "  deleted the firmware bucket"
  else
    echo "  the firmware bucket is already gone"
  fi
}

# delete_table <what> <table>
delete_table() {
  local out
  if [ -z "$2" ]; then
    echo "  the $1 is not known; skipped"
    return 0
  fi
  if ! out="$(aws dynamodb delete-table --table-name "$2" 2>&1)"; then
    case "$out" in
      *ResourceNotFoundException*)
        echo "  the $1 is already gone"
        return 0
        ;;
    esac
    die "$out"
  fi
  aws dynamodb wait table-not-exists --table-name "$2"
  echo "  deleted the $1"
}

main() {
  case "${1:-}" in
    "") ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac

  check_tools
  discover
  confirm
  save_state

  step "1/6 Jobs"
  remove_jobs

  step "2/6 Boards"
  remove_devices

  step "3/6 Buckets"
  empty_bucket_if_present "firmware bucket" "$FIRMWARE_BUCKET"
  empty_bucket_if_present "artifacts bucket" "$ARTIFACTS_BUCKET"

  step "4/6 User pool deletion protection"
  unprotect_user_pool

  step "5/6 Stacks"
  delete_stack "$STACK"
  delete_stack "$BOOTSTRAP_STACK"

  step "6/6 What the stack kept"
  delete_user_pool
  delete_firmware_bucket
  delete_table "release table" "$STATE_TABLE"
  delete_table "audit table" "$AUDIT_TABLE"

  rm -f "$STATE_FILE" "$OUTPUTS_FILE" "$DEPLOY_DIR/packaged.yaml"
  rmdir "$DEPLOY_DIR" 2> /dev/null || true

  echo
  echo "The console is removed. AWS IoT logging for the account is switched off again."
  echo "Left in place: the log group AWSIotLogsV2, if AWS IoT created it, and the budget stack."
  echo "To delete the log group:  aws logs delete-log-group --log-group-name AWSIotLogsV2"
}

main "$@"
