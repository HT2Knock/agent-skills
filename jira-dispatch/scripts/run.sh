#!/usr/bin/env bash
# Start the receiver under launchd.
#
# The webhook secret is kept out of the launchd plist: it is read from
# $HOME/.config/jira-dispatch/secret.env, which must be readable only by you.
#
# Usage: run.sh [<config path>]
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly BIN="${JIRA_DISPATCH_BIN:-$HERE/../bin/jira-dispatch}"
readonly CONFIG="${1:-${JIRA_DISPATCH_CONFIG:-$HOME/.config/jira-dispatch/config.json}}"
readonly SECRET_ENV_FILE="${JIRA_DISPATCH_SECRET_FILE:-$HOME/.config/jira-dispatch/secret.env}"

if [ ! -x "$BIN" ]; then
    printf 'error: %s is missing or not executable; run scripts/install.sh first\n' "$BIN" >&2
    exit 1
fi

if [ -f "$SECRET_ENV_FILE" ]; then
    # shellcheck disable=SC1090 # the file is user-controlled by design.
    source "$SECRET_ENV_FILE"
fi

if [ -z "${JIRA_WEBHOOK_SECRET:-}" ]; then
    printf 'error: JIRA_WEBHOOK_SECRET is not set; put it in %s\n' "$SECRET_ENV_FILE" >&2
    exit 1
fi
export JIRA_WEBHOOK_SECRET

exec "$BIN" -config "$CONFIG"
