#!/usr/bin/env bash
# Start the receiver under launchd.
#
# The webhook secret is kept out of the launchd plist: it is read from
# $HOME/.config/jira-dispatch/secret.env, which must be readable only by you.
#
# Usage: run.sh [<config path>]
set -euo pipefail

# launchd starts a job with a bare PATH. Add the usual places bun can live.
for dir in "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$dir" ]; then
        case ":$PATH:" in
            *":$dir:"*) ;;
            *) PATH="$dir:$PATH" ;;
        esac
    fi
done
export PATH

readonly TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CONFIG="${1:-${JIRA_DISPATCH_CONFIG:-$HOME/.config/jira-dispatch/config.json}}"
readonly SECRET_ENV_FILE="${JIRA_DISPATCH_SECRET_FILE:-$HOME/.config/jira-dispatch/secret.env}"

if ! command -v bun >/dev/null 2>&1; then
    printf 'error: bun is not on PATH\n' >&2
    exit 1
fi

if [ ! -d "$TOOL_DIR/node_modules" ]; then
    printf 'error: %s/node_modules is missing; run scripts/install.sh first\n' "$TOOL_DIR" >&2
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
export JIRA_DISPATCH_CONFIG="$CONFIG"

cd "$TOOL_DIR"
exec bun run "$TOOL_DIR/src/server.ts"
