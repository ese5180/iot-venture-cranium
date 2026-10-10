#!/usr/bin/env bash
#
# Manage the people who may sign in to the Cranium firmware console.
#
#   cloud/users.sh add <email> <viewer|release-manager>   create the account, or change its role
#   cloud/users.sh resend <email>      send the invitation again, with a new temporary password
#   cloud/users.sh reset-mfa <email>   forget the authenticator app, for example after a lost phone
#   cloud/users.sh remove <email>      sign the user out and delete the account
#   cloud/users.sh list                everybody, with role and state
#
# A release manager may upload and revoke firmware and create and cancel deployments.
# A viewer may only look. Cognito e-mails a temporary password to a new user; this
# script never sets or sees a password. E-mail addresses are arguments only and are
# not written anywhere.
#
# The profile and the Region come from AWS_PROFILE and AWS_REGION (default us-east-1).

set -euo pipefail

STACK=cranium-ota
POOL=""

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

usage_error() {
  usage >&2
  exit 2
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

# stack_output <output key>
stack_output() {
  local out
  if ! out="$(aws cloudformation describe-stacks --stack-name "$STACK" \
      --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>&1)"; then
    case "$out" in
      *"does not exist"*) die "the console is not deployed in $AWS_REGION; run cloud/deploy.sh first" ;;
      *) die "$out" ;;
    esac
  fi
  case "$out" in
    ""|None) die "the stack $STACK has no $1 output; run cloud/deploy.sh" ;;
  esac
  printf '%s\n' "$out"
}

# Deliberately strict: the address goes into command arguments.
check_email() {
  if [[ ! "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$ ]]; then
    die "not an e-mail address: $1"
  fi
}

# Prints the user's status (FORCE_CHANGE_PASSWORD, CONFIRMED, ...) or NONE.
user_status() {
  local out
  if out="$(aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$1" \
      --query UserStatus --output text 2>&1 < /dev/null)"; then
    printf '%s\n' "$out"
    return 0
  fi
  case "$out" in
    *UserNotFoundException*)
      printf 'NONE\n'
      ;;
    *)
      printf '%s\n' "$out" >&2
      return 1
      ;;
  esac
}

# Prints the names of the groups the user is in, separated by spaces.
user_groups() {
  aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL" --username "$1" \
    --query 'Groups[].GroupName' --output text < /dev/null | tr '\t\n' '  '
}

# Prints "yes" when the user has registered an authenticator app, else "no".
has_authenticator() {
  local settings
  settings="$(aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$1" \
    --query 'UserMFASettingList' --output text < /dev/null)" || return 1
  case "$settings" in
    *SOFTWARE_TOKEN_MFA*) echo yes ;;
    *) echo no ;;
  esac
}

# Prints the user names (not the e-mail addresses) in a group, separated by spaces.
group_members() {
  aws cognito-idp list-users-in-group --user-pool-id "$POOL" --group-name "$1" \
    --query 'Users[].Username' --output text | tr '\t\n' '  '
}

cmd_add() {
  local email="$1" role="$2" group other status memberships
  case "$role" in
    viewer)
      group=viewers
      other=release-managers
      ;;
    release-manager)
      group=release-managers
      other=viewers
      ;;
    *)
      die "the role must be viewer or release-manager"
      ;;
  esac

  status="$(user_status "$email")"
  if [ "$status" = NONE ]; then
    aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$email" \
      --user-attributes "Name=email,Value=$email" Name=email_verified,Value=true \
      --desired-delivery-mediums EMAIL > /dev/null
    echo "Created an account for $email."
    echo "Cognito e-mails a temporary password that is valid for 3 days. At the first"
    echo "sign-in the user chooses a password and registers an authenticator app."
    echo "Console: $(stack_output ConsoleUrl)"
  else
    echo "$email already has an account; setting the role."
    if [ "$status" = FORCE_CHANGE_PASSWORD ]; then
      echo "The user has not signed in yet. If the invitation has expired or is lost:"
      echo "  cloud/users.sh resend $email"
    fi
  fi

  # Add first and remove second, so that the user is never without a role.
  aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$email" \
    --group-name "$group"
  memberships="$(user_groups "$email")"
  case " $memberships " in
    *" $other "*)
      aws cognito-idp admin-remove-user-from-group --user-pool-id "$POOL" \
        --username "$email" --group-name "$other"
      ;;
  esac
  echo "Role: $role"
}

cmd_resend() {
  local email="$1" status
  status="$(user_status "$email")"
  case "$status" in
    NONE)
      die "there is no account for $email"
      ;;
    FORCE_CHANGE_PASSWORD)
      ;;
    *)
      die "$email has already chosen a password, so there is no invitation to send again." \
        "For a forgotten password, remove the account and add it again."
      ;;
  esac
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$email" \
    --message-action RESEND --desired-delivery-mediums EMAIL > /dev/null
  echo "Sent a new invitation to $email. The earlier temporary password no longer works."
}

cmd_reset_mfa() {
  local email="$1" status registered out
  status="$(user_status "$email")"
  [ "$status" != NONE ] || die "there is no account for $email"
  registered="$(has_authenticator "$email")"
  if [ "$registered" = no ]; then
    echo "$email has no authenticator app registered; nothing to reset."
    return 0
  fi
  if ! out="$(aws cognito-idp admin-delete-software-token --user-pool-id "$POOL" \
      --username "$email" 2>&1)"; then
    case "$out" in
      *"nvalid choice"*) die "this AWS CLI does not know admin-delete-software-token; update the AWS CLI v2" ;;
      *) die "$out" ;;
    esac
  fi
  # A lost phone may be in somebody else's hands: end the sessions as well.
  aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL" --username "$email"
  echo "Removed the authenticator app of $email and signed the user out."
  echo "At the next sign-in the user registers a new one."
}

cmd_remove() {
  local email="$1" status
  status="$(user_status "$email")"
  if [ "$status" = NONE ]; then
    echo "There is no account for $email; nothing to remove."
    return 0
  fi
  aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL" --username "$email" ||
    echo "Could not sign $email out first; deleting the account anyway." >&2
  aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username "$email"
  echo "Removed $email."
  echo "The console refuses every change by this user from now on. A browser that is"
  echo "still signed in can keep reading until its session ends, at most 60 minutes."
}

cmd_list() {
  local users managers viewers username email status enabled role state registered
  users="$(aws cognito-idp list-users --user-pool-id "$POOL" \
    --query "Users[].[Username, Attributes[?Name=='email'].Value | [0], UserStatus, Enabled]" \
    --output text)"
  case "$users" in
    ""|None)
      echo "Nobody has an account yet. Add the first one with:"
      echo "  cloud/users.sh add <email> release-manager"
      return 0
      ;;
  esac
  managers=" $(group_members release-managers) "
  viewers=" $(group_members viewers) "

  printf '%-40s %-16s %-9s %s\n' "E-MAIL" "ROLE" "STATE" "AUTHENTICATOR"
  while IFS=$'\t' read -r username email status enabled; do
    [ -n "$username" ] || continue
    role="none"
    case "$viewers" in *" $username "*) role="viewer" ;; esac
    case "$managers" in *" $username "*) role="release-manager" ;; esac
    case "$status" in
      CONFIRMED) state="active" ;;
      FORCE_CHANGE_PASSWORD) state="invited" ;;
      *) state="$status" ;;
    esac
    [ "$enabled" = True ] || state="disabled"
    registered="$(has_authenticator "$username")"
    printf '%-40s %-16s %-9s %s\n' "$email" "$role" "$state" "$registered"
  done <<< "$users"
}

main() {
  local command="${1:-}"
  case "$command" in
    add)
      [ $# -eq 3 ] || usage_error
      check_email "$2"
      case "$3" in
        viewer|release-manager) ;;
        *) die "the role must be viewer or release-manager" ;;
      esac
      ;;
    resend|reset-mfa|remove)
      [ $# -eq 2 ] || usage_error
      check_email "$2"
      ;;
    list)
      [ $# -eq 1 ] || usage_error
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      usage_error
      ;;
  esac

  check_tools
  POOL="$(stack_output UserPoolId)"

  case "$command" in
    add) cmd_add "$2" "$3" ;;
    resend) cmd_resend "$2" ;;
    reset-mfa) cmd_reset_mfa "$2" ;;
    remove) cmd_remove "$2" ;;
    list) cmd_list ;;
  esac
}

main "$@"
