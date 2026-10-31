#!/usr/bin/env bash
#
# Keep a record of what is done in the AWS account, in a stack of its own.
#
#   AWS_PROFILE=<profile> cloud/trail.sh            create or update the trail
#   AWS_PROFILE=<profile> cloud/trail.sh --status   say whether it is logging, change nothing
#
# It deploys cloud/infra/trail.yaml as the stack cranium-trail: one multi-Region CloudTrail
# trail of management events with log file validation, in a private bucket that only
# answers over TLS and that expires its files after a year. Nothing else deploys this, and
# cloud/teardown.sh does not touch it.
#
# The first copy of management events is free, so it stops if another trail exists: a
# second copy costs $2.00 per 100,000 events. "An account record" in cloud/README.md has
# the cost, what the trail does not record, and how to remove it.
#
# The profile and the Region come from AWS_PROFILE and AWS_REGION (default us-east-1).

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK=cranium-trail
TRAIL=cranium-trail

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

# Prints the status of the stack, or NONE when it does not exist.
stack_status() {
  local out
  if out="$(aws cloudformation describe-stacks --stack-name "$STACK" \
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

# stack_output <output key>
stack_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

# Another trail that delivers management events turns this one into a paid second copy.
check_no_other_trail() {
  local others
  others="$(aws cloudtrail describe-trails --include-shadow-trails \
    --query "trailList[?Name!='$TRAIL'].[Name, HomeRegion]" --output text)"
  case "$others" in
    ""|None) ;;
    *)
      printf '%s\n' "$others" >&2
      die "this account already has the trail above, so a further copy of its management" \
        "events would cost \$2.00 per 100,000 events. Nothing was changed. Delete that trail" \
        "if it is not needed, or use it instead of this one."
      ;;
  esac
}

show_status() {
  local status logging error validated
  status="$(stack_status)"
  echo "Stack $STACK: $status"
  [ "$status" != NONE ] || return 0
  logging="$(aws cloudtrail get-trail-status --name "$TRAIL" --query IsLogging --output text)"
  error="$(aws cloudtrail get-trail-status --name "$TRAIL" \
    --query LatestDeliveryError --output text)"
  validated="$(aws cloudtrail get-trail --name "$TRAIL" \
    --query 'Trail.[IsMultiRegionTrail, LogFileValidationEnabled]' --output text)"
  echo "Logging: $logging"
  echo "Multi-Region, log file validation: $validated"
  case "$error" in
    ""|None) ;;
    *) echo "Last delivery error: $error" ;;
  esac
  echo "Bucket: $(stack_output TrailBucketName)"
  echo "To check the log files for changes since a given time:"
  echo "  aws cloudtrail validate-logs --trail-arn $(stack_output TrailArn) \\"
  echo "    --start-time <time, such as 2026-11-01T00:00:00Z>"
}

deploy() {
  local account status
  account="$(aws sts get-caller-identity --query Account --output text)" ||
    die "no usable AWS credentials; set AWS_PROFILE to a signed-in profile"
  echo "Account $account, Region $AWS_REGION"

  status="$(stack_status)"
  case "$status" in
    ROLLBACK_COMPLETE)
      # A failed first creation holds nothing and cannot be updated.
      echo "$STACK is left over from a failed creation and is empty; deleting it"
      aws cloudformation delete-stack --stack-name "$STACK"
      aws cloudformation wait stack-delete-complete --stack-name "$STACK"
      ;;
    *_IN_PROGRESS)
      die "$STACK is busy ($status). Wait until it has finished and run this again."
      ;;
  esac
  check_no_other_trail

  if ! aws cloudformation deploy --stack-name "$STACK" \
      --template-file "$CLOUD_DIR/infra/trail.yaml" --no-fail-on-empty-changeset; then
    aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 100 \
      --query "StackEvents[?ends_with(ResourceStatus, '_FAILED')].[LogicalResourceId, ResourceStatusReason]" \
      --output text >&2 || true
    die "$STACK was not deployed"
  fi
  show_status
}

main() {
  case "${1:-}" in
    "")
      check_tools
      deploy
      ;;
    --status)
      check_tools
      show_status
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
