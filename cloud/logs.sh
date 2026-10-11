#!/usr/bin/env bash
#
# Follow one of the logs of the Cranium firmware console. Read only; stop with Ctrl-C.
#
#   cloud/logs.sh api      the API function: one JSON line per request, and errors
#   cloud/logs.sh web      the function that serves the console's static files
#   cloud/logs.sh access   API Gateway: every request, with status and authorizer error
#   cloud/logs.sh iot      AWS IoT: connections, refused publishes, job events
#
# Further arguments go to "aws logs tail", for example:
#
#   cloud/logs.sh api --since 2h
#   cloud/logs.sh iot --filter-pattern ERROR
#
# Where to look: a 401 is explained by authorizerError in the access log; a 500 with
# no line in the api log is explained by integrationError in the access log; a board
# whose connection AWS IoT refuses shows up in the iot log as a Connect entry with
# status Failure.
#
# Search the access log with text patterns, not JSON patterns. API Gateway cannot
# escape its own error messages, so a line that carries one may not be valid JSON, and
# a JSON pattern passes such lines over. The two messages come last in a line; what
# stands before "integrationError" can always be relied on. For example:
#
#   cloud/logs.sh access --filter-pattern '"invalid_token"'       refused tokens
#   cloud/logs.sh access --filter-pattern '"\"status\":\"401\""'  every 401
#
# The profile and the Region come from AWS_PROFILE and AWS_REGION (default us-east-1).

set -euo pipefail

STACK=cranium-ota
IOT_LOG_GROUP=AWSIotLogsV2

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

# Prints the name of the log group behind a logical resource of the stack.
stack_log_group() {
  local out
  if ! out="$(aws cloudformation describe-stack-resource --stack-name "$STACK" \
      --logical-resource-id "$1" --query 'StackResourceDetail.PhysicalResourceId' \
      --output text 2>&1)"; then
    case "$out" in
      *"does not exist"*) die "the console is not deployed in $AWS_REGION; run cloud/deploy.sh first" ;;
      *) die "$out" ;;
    esac
  fi
  printf '%s\n' "$out"
}

# AWS IoT creates its log group when it writes the first entry.
iot_log_group_exists() {
  local found
  found="$(aws logs describe-log-groups --log-group-name-prefix "$IOT_LOG_GROUP" \
    --query "length(logGroups[?logGroupName=='$IOT_LOG_GROUP'])" --output text)" ||
    die "could not list the log groups in $AWS_REGION"
  [ "$found" = 1 ]
}

main() {
  local group
  case "${1:-}" in
    api) check_tools; group="$(stack_log_group ApiLogGroup)" ;;
    web) check_tools; group="$(stack_log_group WebLogGroup)" ;;
    access) check_tools; group="$(stack_log_group AccessLogGroup)" ;;
    iot)
      check_tools
      group="$IOT_LOG_GROUP"
      if ! iot_log_group_exists; then
        echo "AWS IoT has not logged anything in $AWS_REGION yet."
        echo "Its log group appears when the first board connects."
        exit 0
      fi
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
  exec aws logs tail "$group" --follow --format short "$@"
}

main "$@"
