#!/usr/bin/env bash
#
# Check a deployed Cranium firmware console from the outside. It changes nothing.
#
#   AWS_PROFILE=<profile> cloud/smoke.sh
#
# 1. GET / answers 200 and its Content-Security-Policy allows the sign-in host.
# 2. GET /api/me without a token answers 401.
# 3. The managed login page loads for the real app client and redirect URI. After a
#    first deployment this can take a few minutes, so it is retried for 5 minutes.
# 4. The API function, invoked directly with the event of a viewer, refuses a subject
#    that has no account. That proves the live check on reads, and that the function
#    can reach Cognito.
# 5. The same event with the subject of a real active account answers 200 for the
#    device, firmware, deployment and activity lists. That exercises the function's
#    permissions and every AWS SDK client it uses, without a password or an
#    authenticator code. Without an active account yet, this step is skipped and says so.
#
# The events in steps 4 and 5 are made up and only read. They leave one line per request
# in the API log, whose request id starts with "smoke-", and nothing else. Step 5 does
# name a real person's subject in those lines; that person's address is never read.
#
# The profile and the Region come from AWS_PROFILE and AWS_REGION (default us-east-1).
# Needs the AWS CLI v2, curl and openssl. Temporary files stay in cloud/.deploy/.

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$CLOUD_DIR/.deploy"
STACK=cranium-ota
SMOKE_SUB=00000000-0000-0000-0000-000000000000
LOGIN_WAIT_SECONDS=300

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""

OUTPUTS=""
WORK=""
CHECKS=0
FAILURES=0
BASE_URL=""
API_HOST=""
LOGIN_DOMAIN=""
CLIENT_ID=""
USER_POOL_ID=""
API_FUNCTION=""
LOGIN_STATUS=""
LOGIN_URL=""
INVOKE_ERROR=""

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

pass() {
  printf 'ok      %s\n' "$1"
  CHECKS=$((CHECKS + 1))
}

# fail <check> [details ...]
fail() {
  local line
  printf 'FAILED  %s\n' "$1"
  shift
  for line in "$@"; do
    [ -z "$line" ] || printf '        %s\n' "$line"
  done
  CHECKS=$((CHECKS + 1))
  FAILURES=$((FAILURES + 1))
}

check_tools() {
  local version tool
  command -v aws > /dev/null || die "the AWS CLI is not installed"
  version="$(aws --version 2>&1)"
  case "$version" in
    aws-cli/2.*) ;;
    *) die "the AWS CLI v2 is needed (found: $version)" ;;
  esac
  for tool in curl openssl; do
    command -v "$tool" > /dev/null || die "$tool is not installed"
  done
}

load_outputs() {
  if ! OUTPUTS="$(aws cloudformation describe-stacks --stack-name "$STACK" \
      --query 'Stacks[0].Outputs[].[OutputKey, OutputValue]' --output text 2>&1)"; then
    case "$OUTPUTS" in
      *"does not exist"*) die "the console is not deployed in $AWS_REGION; run cloud/deploy.sh first" ;;
      *) die "$OUTPUTS" ;;
    esac
  fi
}

# output <output key>
output() {
  local value
  value="$(printf '%s\n' "$OUTPUTS" | awk -F '\t' -v key="$1" '$1 == key { print $2 }')"
  [ -n "$value" ] || die "the stack $STACK has no $1 output; run cloud/deploy.sh"
  printf '%s\n' "$value"
}

check_console() {
  local name="GET / answers 200 and its Content-Security-Policy allows the sign-in host"
  local status csp
  status="$(curl -sS --max-time 30 -o /dev/null -D "$WORK/headers" -w '%{http_code}' \
    "$BASE_URL/" 2> "$WORK/error")" || status="no answer"
  if [ "$status" != 200 ]; then
    fail "$name" "status: $status" "$(cat "$WORK/error")"
    return 0
  fi
  csp="$(grep -i '^content-security-policy:' "$WORK/headers" || true)"
  case "$csp" in
    "")
      fail "$name" "the answer has no Content-Security-Policy header"
      ;;
    *"https://$LOGIN_DOMAIN"*)
      pass "$name"
      ;;
    *)
      fail "$name" "the Content-Security-Policy does not name https://$LOGIN_DOMAIN"
      ;;
  esac
}

check_token_is_required() {
  local name="GET /api/me without a token answers 401"
  local status
  status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
    "$BASE_URL/api/me" 2> "$WORK/error")" || status="no answer"
  if [ "$status" = 401 ]; then
    pass "$name"
  else
    fail "$name" "status: $status" "$(cat "$WORK/error")"
  fi
}

# One attempt to open the sign-in page the way the console does: an authorization
# request with PKCE that is never completed. Sets LOGIN_STATUS and LOGIN_URL.
login_page_loads() {
  local state verifier challenge answer
  state="$(openssl rand -hex 32)"
  verifier="$(openssl rand -hex 32)"
  challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A |
    tr '+/' '-_' | tr -d '=')"
  LOGIN_STATUS="no answer"
  LOGIN_URL="https://$LOGIN_DOMAIN/oauth2/authorize"
  answer="$(curl -sS -L --max-redirs 5 --max-time 30 -o "$WORK/login.html" \
    -w '%{http_code} %{url_effective}' -G "https://$LOGIN_DOMAIN/oauth2/authorize" \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "response_type=code" \
    --data-urlencode "scope=openid cranium/console" \
    --data-urlencode "redirect_uri=$BASE_URL/" \
    --data-urlencode "state=$state" \
    --data-urlencode "code_challenge=$challenge" \
    --data-urlencode "code_challenge_method=S256" 2> "$WORK/error")" || return 1
  LOGIN_STATUS="${answer%% *}"
  # Without the query string: nothing in it is secret here, but URLs with query
  # strings do not belong in terminals and logs.
  LOGIN_URL="${answer#* }"
  LOGIN_URL="${LOGIN_URL%%\?*}"
  [ "$LOGIN_STATUS" = 200 ] || return 1
  # An error page is served from /error on the same host.
  case "$LOGIN_URL" in
    "https://$LOGIN_DOMAIN/login"*) ;;
    *) return 1 ;;
  esac
  # A page that works carries the sign-in form. Looking for the words "Login pages
  # unavailable" instead would prove nothing: every managed login page contains
  # them in its table of messages, also when it works.
  if ! grep -q 'name="password"' "$WORK/login.html"; then
    LOGIN_STATUS="200, but the page has no sign-in form"
    return 1
  fi
}

check_login_page() {
  local name="the managed login page loads for the console's app client and redirect URI"
  local deadline waiting=no
  deadline=$(($(date +%s) + LOGIN_WAIT_SECONDS))
  while ! login_page_loads; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "$name" "last answer: $LOGIN_STATUS from $LOGIN_URL" "$(cat "$WORK/error")"
      return 0
    fi
    if [ "$waiting" = no ]; then
      echo "        waiting for the sign-in page; a new deployment can need a few minutes"
      waiting=yes
    fi
    sleep 15
  done
  pass "$name"
}

# The event API Gateway hands to the function for "GET <path>" from a signed-in
# viewer. Claims arrive as strings, and the groups as one string in brackets.
api_event() {
  local path="$1" sub="$2" now request_id
  now="$(date +%s)"
  request_id="smoke-$(openssl rand -hex 8)"
  cat << EOF
{
  "version": "2.0",
  "routeKey": "GET /api/{proxy+}",
  "rawPath": "$path",
  "rawQueryString": "",
  "headers": {
    "accept": "application/json",
    "host": "$API_HOST",
    "user-agent": "cranium-smoke",
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-port": "443",
    "x-forwarded-proto": "https"
  },
  "requestContext": {
    "apiId": "${API_HOST%%.*}",
    "authorizer": {
      "jwt": {
        "claims": {
          "auth_time": "$now",
          "client_id": "$CLIENT_ID",
          "cognito:groups": "[viewers]",
          "exp": "$((now + 300))",
          "iat": "$now",
          "iss": "https://cognito-idp.$AWS_REGION.amazonaws.com/$USER_POOL_ID",
          "jti": "$request_id",
          "scope": "openid cranium/console",
          "sub": "$sub",
          "token_use": "access",
          "username": "$sub",
          "version": "2"
        },
        "scopes": ["cranium/console"]
      }
    },
    "domainName": "$API_HOST",
    "domainPrefix": "${API_HOST%%.*}",
    "http": {
      "method": "GET",
      "path": "$path",
      "protocol": "HTTP/1.1",
      "sourceIp": "127.0.0.1",
      "userAgent": "cranium-smoke"
    },
    "requestId": "$request_id",
    "routeKey": "GET /api/{proxy+}",
    "stage": "\$default",
    "time": "$(date -u '+%d/%b/%Y:%H:%M:%S +0000')",
    "timeEpoch": ${now}000
  },
  "pathParameters": { "proxy": "${path#/api/}" },
  "isBase64Encoded": false
}
EOF
}

# The subject of one active account, or nothing. Any member will do: the event only reads.
active_subject() {
  local group sub
  for group in viewers release-managers; do
    sub="$(aws cognito-idp list-users-in-group --user-pool-id "$USER_POOL_ID" --group-name "$group" \
      --query "Users[?Enabled && UserStatus=='CONFIRMED'] | [0].Attributes[?Name=='sub'] | [0].Value" \
      --output text)" || return 1
    case "$sub" in
      ""|None) ;;
      *)
        printf '%s\n' "$sub"
        return 0
        ;;
    esac
  done
}

# invoke_api <path> <sub>: writes the function's answer to answer.json and prints
# nothing. Returns non-zero and sets INVOKE_ERROR if the function could not answer.
invoke_api() {
  local error
  api_event "$1" "$2" > "$WORK/event.json"
  if ! error="$(aws lambda invoke --function-name "$API_FUNCTION" \
      --payload "fileb://$WORK/event.json" --query FunctionError --output text \
      "$WORK/answer.json" 2>&1)"; then
    INVOKE_ERROR="$error"
    return 1
  fi
  if [ "$error" != None ]; then
    INVOKE_ERROR="the function failed ($error); see cloud/logs.sh api"
    return 1
  fi
}

answer_status() {
  sed -n 's/.*"statusCode":\([0-9][0-9]*\).*/\1/p' "$WORK/answer.json"
}

check_unknown_subject_is_refused() {
  local name="the API function refuses a read for a subject that has no account"
  local status
  if ! invoke_api /api/devices "$SMOKE_SUB"; then
    fail "$name" "$INVOKE_ERROR"
    return 0
  fi
  # A 200 means that the live check is missing, or that it could not ask Cognito, which
  # lets a read go on. The API log says which: look for live_check_failed.
  status="$(answer_status)"
  if [ "$status" = 403 ] && grep -q 'account_inactive' "$WORK/answer.json"; then
    pass "$name"
  else
    fail "$name" "it answered ${status:-without a status}; see cloud/logs.sh api"
  fi
}

# check_api_route <path> <sub>
check_api_route() {
  local path="$1" sub="$2" name="the API function answers 200 for GET $1 as a member"
  local status
  if ! invoke_api "$path" "$sub"; then
    fail "$name" "$INVOKE_ERROR"
    return 0
  fi
  # The answer itself is never printed: it can hold names and e-mail addresses.
  status="$(answer_status)"
  if [ "$status" = 200 ]; then
    pass "$name"
  else
    fail "$name" "it answered ${status:-without a status}; see cloud/logs.sh api"
  fi
}

main() {
  local path sub
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
  load_outputs
  BASE_URL="$(output ConsoleUrl)"
  BASE_URL="${BASE_URL%/}"
  API_HOST="${BASE_URL#https://}"
  LOGIN_DOMAIN="$(output LoginDomain)"
  CLIENT_ID="$(output UserPoolClientId)"
  USER_POOL_ID="$(output UserPoolId)"
  API_FUNCTION="$(output ApiFunctionName)"

  umask 077
  mkdir -p "$DEPLOY_DIR"
  WORK="$(mktemp -d "$DEPLOY_DIR/smoke.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  : > "$WORK/error"

  echo "Checking $BASE_URL/"
  check_console
  check_token_is_required
  check_login_page
  check_unknown_subject_is_refused
  sub="$(active_subject)" || die "could not read the accounts of the user pool"
  if [ -n "$sub" ]; then
    for path in /api/devices /api/firmware /api/deployments /api/audit; do
      check_api_route "$path" "$sub"
    done
  else
    echo "skipped the device, firmware, deployment and activity lists: nobody has finished"
    echo "a first sign-in yet (cloud/users.sh add <email> release-manager)"
  fi

  echo
  if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES of $CHECKS checks failed."
    exit 1
  fi
  echo "All $CHECKS checks passed."
}

main "$@"
