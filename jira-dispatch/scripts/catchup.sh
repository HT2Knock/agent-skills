#!/usr/bin/env bash
# Start sessions for tickets that became ready while the receiver was down.
#
# This is not a poll. Run it once when the receiver starts, or by hand when you
# sit down. The JQL is the same trigger the webhook filters on.
#
# Usage: catchup.sh [<config path>] [<jql>]
set -euo pipefail

readonly CONFIG="${1:-${JIRA_DISPATCH_CONFIG:-$HOME/.config/jira-dispatch/config.json}}"
readonly SECRET_ENV_FILE="${JIRA_DISPATCH_SECRET_FILE:-$HOME/.config/jira-dispatch/secret.env}"
readonly LIMIT="${JIRA_DISPATCH_CATCHUP_LIMIT:-50}"

if [ ! -f "$CONFIG" ]; then
    printf 'error: no config at %s\n' "$CONFIG" >&2
    exit 1
fi

# Read the fields this script needs out of the config. Tab separated, because
# a value may contain a space.
IFS=$'\t' read -r SECRET_ENV LISTEN ACTOR LABELS < <(python3 - "$CONFIG" <<'PY'
import json, sys

cfg = json.load(open(sys.argv[1]))
actors = cfg.get("allowedActors") or []
print("\t".join([
    cfg["secretEnv"],
    cfg["listen"],
    actors[0] if actors else "",
    ",".join(cfg.get("triggerLabels") or []),
]))
PY
)

if [ -f "$SECRET_ENV_FILE" ]; then
    # shellcheck disable=SC1090 # the file is user-controlled by design.
    source "$SECRET_ENV_FILE"
fi

readonly SECRET="${!SECRET_ENV:-}"
if [ -z "$SECRET" ]; then
    printf 'error: %s is not set; put it in %s\n' "$SECRET_ENV" "$SECRET_ENV_FILE" >&2
    exit 1
fi

readonly URL="${JIRA_DISPATCH_URL:-http://$LISTEN/jira/hook}"
RESPONSE="$(mktemp)"
readonly RESPONSE
trap 'rm -f "$RESPONSE"' EXIT

# Build the default query from the trigger labels in the config.
if [ "${2:-}" != "" ]; then
    JQL="$2"
elif [ -n "$LABELS" ]; then
    quoted="$(printf '%s' "$LABELS" | awk -F, '{for(i=1;i<=NF;i++) printf "%s\"%s\"", (i>1 ? "," : ""), $i}')"
    JQL="assignee = currentUser() AND labels in ($quoted) AND statusCategory != Done ORDER BY updated DESC"
else
    JQL="assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
fi

printf 'query: %s\n' "$JQL"
printf 'post:  %s\n\n' "$URL"

# One webhook-shaped payload per ready issue. The changelog id is derived from
# the ticket and its updated time, so a second catch-up on the same revision is
# a no-op.
atlassian-cli jira issue search --jql "$JQL" --limit "$LIMIT" --format json |
    python3 -c '
import json, sys

actor = sys.argv[1]
for issue in json.load(sys.stdin):
    fields = issue.get("fields", {})
    print(json.dumps({
        "webhookEvent": "jira:issue_assigned",
        "timestamp": 0,
        "issue": {
            "id": issue.get("id", ""),
            "key": issue["key"],
            "fields": {
                "summary": fields.get("summary", ""),
                "labels": fields.get("labels", []),
                "assignee": fields.get("assignee") or {},
                "issuetype": fields.get("issuetype") or {},
                "priority": fields.get("priority") or {},
            },
        },
        "user": {"emailAddress": actor},
        "changelog": {"id": "catchup:%s:%s" % (issue["key"], fields.get("updated", ""))},
    }))
' "${ACTOR:-unknown@example.com}" |
    while IFS= read -r payload; do
        key="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin)["issue"]["key"])')"
        sig="$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
        code="$(curl -sS -o "$RESPONSE" -w '%{http_code}' \
            -H "X-Hub-Signature: sha256=$sig" \
            -H 'Content-Type: application/json' \
            --data-binary "$payload" "$URL")"
        kind="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["kind"])' "$RESPONSE" 2>/dev/null || printf '?')"
        printf '%-12s %s %s\n' "$key" "$code" "$kind"
    done

printf '\ndone\n'
