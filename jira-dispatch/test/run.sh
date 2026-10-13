#!/usr/bin/env bash
# End-to-end check for the jira-dispatch receiver.
#
# Runs offline: no Jira, no OpenCode. The launch command is a fake that records
# its argv, so the check proves what the receiver would have started.
#
# Usage: test/run.sh
set -euo pipefail

readonly TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TMP="$(mktemp -d)"
readonly SECRET="test-secret-value"
readonly OTHER_SECRET="a-different-secret"
readonly DISPATCH_LOG="$TMP/dispatched.log"
readonly STATE="$TMP/state"
readonly WORKMODE="$TMP/workmode"
readonly ME="ngoc@example.com"

pass=0
fail=0
receiver_pid=""
addr=""

cleanup() {
    if [ -n "$receiver_pid" ]; then
        kill "$receiver_pid" 2>/dev/null || true
        wait "$receiver_pid" 2>/dev/null || true
    fi
    rm -rf "$TMP"
}
trap cleanup EXIT

check() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf 'PASS  %s\n' "$label"
        pass=$((pass + 1))
    else
        printf 'FAIL  %s: expected [%s], got [%s]\n' "$label" "$expected" "$actual"
        fail=$((fail + 1))
    fi
}

sign() { # body secret -> hex
    printf '%s' "$1" | openssl dgst -sha256 -hmac "$2" | awk '{print $NF}'
}

post() { # body -> status code; response body lands in $TMP/last.json
    local body="$1" sig
    sig="$(sign "$body" "$SECRET")"
    curl -sS -o "$TMP/last.json" -w '%{http_code}' \
        -H "X-Hub-Signature: sha256=$sig" \
        -H 'Content-Type: application/json' \
        --data-binary "$body" \
        "http://$addr/jira/hook"
}

post_unsigned() {
    curl -sS -o "$TMP/last.json" -w '%{http_code}' \
        -H 'Content-Type: application/json' \
        --data-binary "$1" "http://$addr/jira/hook"
}

post_wrong_secret() {
    local sig
    sig="$(sign "$1" "$OTHER_SECRET")"
    curl -sS -o "$TMP/last.json" -w '%{http_code}' \
        -H "X-Hub-Signature: sha256=$sig" \
        -H 'Content-Type: application/json' \
        --data-binary "$1" "http://$addr/jira/hook"
}

payload() { # key event label actor changelog_id changed_field to_string
    cat <<JSON
{
  "webhookEvent": "$2",
  "timestamp": 1750000000,
  "issue": {
    "id": "10001",
    "key": "$1",
    "fields": {
      "summary": "Fix the assortment variant",
      "labels": ["$3"],
      "assignee": {"accountId": "acc-1", "emailAddress": "$4"},
      "issuetype": {"name": "Bug"},
      "priority": {"name": "High"}
    }
  },
  "user": {"accountId": "acc-1", "emailAddress": "$4"},
  "changelog": {"id": "$5", "items": [{"field": "$6", "fromString": "", "toString": "$7"}]}
}
JSON
}

run_count() {
    if [ -d "$STATE/runs" ]; then
        find "$STATE/runs" -type f -name '*.json' | wc -l | tr -d ' '
    else
        printf '0'
    fi
}

kind_of() {
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kind"])' "$TMP/last.json"
}

record_field() { # field name -> value from the newest run record
    python3 -c '
import glob, json, os, sys
files = sorted(glob.glob(sys.argv[1]), key=os.path.getmtime)
print(json.load(open(files[-1]))[sys.argv[2]] if files else "")
' "$STATE/runs/*.json" "$1"
}

wait_for() { # file pattern seconds
    local file="$1" pattern="$2" seconds="${3:-8}" i
    for ((i = 0; i < seconds * 10; i++)); do
        if [ -f "$file" ] && grep -q -- "$pattern" "$file" 2>/dev/null; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

wait_gone() { # path seconds
    local path="$1" seconds="${2:-8}" i
    for ((i = 0; i < seconds * 10; i++)); do
        if [ ! -e "$path" ]; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

present() { # path -> yes/no
    if [ -e "$1" ]; then printf 'yes'; else printf 'no'; fi
}

# ---------------------------------------------------------------- setup

cat >"$TMP/fake-launch.sh" <<'SH'
#!/usr/bin/env bash
# Stands in for `opencode run`. It sleeps so the check can prove that the
# ticket lock is held for the whole session, not only for the prepare step.
sleep 2
printf 'launched key=%s summary=%s\n' "$1" "$2" >>"$DISPATCH_LOG"
printf 'prompt=%s\n' "$3" >>"$DISPATCH_LOG"
SH
chmod +x "$TMP/fake-launch.sh"
export DISPATCH_LOG

cat >"$TMP/config.json" <<JSON
{
  "listen": "127.0.0.1:0",
  "secretEnv": "TEST_WEBHOOK_SECRET",
  "stateDir": "$STATE",
  "workModePath": "$WORKMODE",
  "jiraBaseUrl": "https://example.atlassian.net",
  "allowedActors": ["$ME"],
  "allowedEvents": ["jira:issue_assigned", "jira:issue_updated"],
  "triggerLabels": ["agent-ready"],
  "lockTtlHours": 6,
  "projects": {
    "ADAM": {
      "workspace": "$TMP/ws/{key}",
      "prepareDir": "$TMP",
      "prepare": ["/usr/bin/true"],
      "launch": ["$TMP/fake-launch.sh", "{key}", "{summary}", "{prompt}"],
      "promptTemplate": "Ticket {key}: {summary}\nURL: {url}\nWorkspace: {workspace}\nwork the ticket fully."
    }
  }
}
JSON

( cd "$TOOL_DIR" && go build -o "$TMP/jira-dispatch" . )

export TEST_WEBHOOK_SECRET="$SECRET"
"$TMP/jira-dispatch" -config "$TMP/config.json" >"$TMP/stdout.log" 2>"$TMP/stderr.log" &
receiver_pid=$!

for _ in $(seq 1 60); do
    addr="$(sed -n 's|^listening on http://||p' "$TMP/stdout.log" | head -1)"
    if [ -n "$addr" ]; then
        break
    fi
    sleep 0.1
done

if [ -z "$addr" ]; then
    printf 'FATAL: the receiver did not report a listening address\n'
    cat "$TMP/stderr.log"
    exit 1
fi
printf 'receiver on %s\n\n' "$addr"

# ---------------------------------------------------------------- checks

health="$(curl -sS -o "$TMP/health.json" -w '%{http_code}' "http://$addr/healthz")"
check "health endpoint answers" "200" "$health"

# Work mode is off here. The event is well formed and signed.
offmode="$(payload ADAM-900 jira:issue_assigned agent-ready "$ME" chg-off labels agent-ready)"
code="$(post "$offmode")"
check "work mode off: accepted but ignored" "200" "$code"
check "work mode off: reported as ignored" "ignored" "$(kind_of)"
check "work mode off: nothing started" "0" "$(run_count)"

touch "$WORKMODE"

# Work mode is on. These two must still start nothing.
code="$(post_unsigned "$offmode")"
check "unsigned request is rejected" "401" "$code"
check "unsigned request starts nothing" "0" "$(run_count)"

code="$(post_wrong_secret "$offmode")"
check "wrongly signed request is rejected" "401" "$code"
check "wrongly signed request starts nothing" "0" "$(run_count)"

# The real thing: the label is added to the ticket.
first="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-1 labels agent-ready)"
code="$(post "$first")"
check "label added: accepted" "202" "$code"
check "label added: reported as dispatched" "dispatched" "$(kind_of)"
check "label added: one run recorded" "1" "$(run_count)"

check "workspace placeholder is expanded" "$TMP/ws/ADAM-900" "$(record_field workspace)"
check "workspace directory exists" "yes" "$(present "$TMP/ws/ADAM-900")"
check "prompt file holds the key" "yes" "$(grep -q 'ADAM-900' "$STATE"/spool/*.prompt.txt && echo yes || echo no)"
check "prompt holds the browse url" "yes" "$(grep -q 'https://example.atlassian.net/browse/ADAM-900' "$STATE"/spool/*.prompt.txt && echo yes || echo no)"
check "prompt holds the expanded workspace" "yes" "$(grep -q "$TMP/ws/ADAM-900" "$STATE"/spool/*.prompt.txt && echo yes || echo no)"

# The session is running and sleeping. Both of these must land inside it.
code="$(post "$first")"
check "duplicate event id: accepted but not started" "200" "$code"
check "duplicate event id: reported as duplicate" "duplicate" "$(kind_of)"
check "duplicate event id: still one run" "1" "$(run_count)"

inflight="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-2 labels agent-ready)"
code="$(post "$inflight")"
check "same ticket while the session runs: not started" "200" "$code"
check "same ticket while the session runs: reported in-flight" "in-flight" "$(kind_of)"
check "same ticket while the session runs: no second run" "1" "$(run_count)"
check "ticket lock is held while the session runs" "yes" "$(present "$STATE/lock/ADAM-900")"

if wait_for "$DISPATCH_LOG" "launched key=ADAM-900"; then
    check "the session actually started" "yes" "yes"
else
    check "the session actually started" "yes" "no"
fi
check "{prompt} reached the launch command" "yes" "$(grep -q 'Ticket ADAM-900' "$DISPATCH_LOG" && echo yes || echo no)"

if wait_gone "$STATE/lock/ADAM-900"; then
    check "ticket lock is released when the session ends" "yes" "yes"
else
    check "ticket lock is released when the session ends" "yes" "no"
fi

# The session comments on its own ticket. That must not start another session.
owncomment="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-3 comment "opened a draft PR")"
code="$(post "$owncomment")"
check "a comment on the ticket is ignored" "200" "$code"
check "a comment on the ticket is reported as ignored" "ignored" "$(kind_of)"
check "a comment on the ticket starts nothing" "1" "$(run_count)"

# An ordinary field edit that did not add the label is not a hand-off.
edited="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-4 summary "A new summary")"
code="$(post "$edited")"
check "a non-label edit is ignored" "ignored" "$(kind_of)"
check "a non-label edit starts nothing" "1" "$(run_count)"

# A fresh assignment is a hand-off, with no changelog.
assigned="$(payload ADAM-911 jira:issue_assigned agent-ready "$ME" chg-5 labels agent-ready)"
code="$(post "$assigned")"
check "a fresh assignment starts" "202" "$code"
check "a fresh assignment: second run recorded" "2" "$(run_count)"

foreign="$(payload ADAM-901 jira:issue_assigned agent-ready someone-else@example.com chg-6 labels agent-ready)"
code="$(post "$foreign")"
check "foreign actor: accepted but ignored" "200" "$code"
check "foreign actor: reported as ignored" "ignored" "$(kind_of)"
check "foreign actor: nothing started" "2" "$(run_count)"

unlabeled="$(payload ADAM-902 jira:issue_assigned some-other-label "$ME" chg-7 labels some-other-label)"
code="$(post "$unlabeled")"
check "missing trigger label: ignored" "ignored" "$(kind_of)"
check "missing trigger label: nothing started" "2" "$(run_count)"

unknown="$(payload OTHER-903 jira:issue_assigned agent-ready "$ME" chg-8 labels agent-ready)"
code="$(post "$unknown")"
check "unknown project: ignored" "ignored" "$(kind_of)"
check "unknown project: nothing started" "2" "$(run_count)"

# ---------------------------------------------------------------- catch-up

# A stand-in for atlassian-cli, so the catch-up path is exercised offline.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/atlassian-cli" <<EOF
#!/usr/bin/env bash
printf '%s\n' '[{"id":"10002","key":"ADAM-920","fields":{"summary":"Catch-up ticket","labels":["agent-ready"],"updated":"2026-10-13T09:00:00.000+0700","assignee":{"emailAddress":"$ME"},"issuetype":{"name":"Bug"},"priority":{"name":"High"}}}]'
EOF
chmod +x "$TMP/bin/atlassian-cli"

printf 'TEST_WEBHOOK_SECRET=%s\n' "$SECRET" >"$TMP/secret.env"

before="$(run_count)"
out="$(PATH="$TMP/bin:$PATH" \
    JIRA_DISPATCH_URL="http://$addr/jira/hook" \
    JIRA_DISPATCH_SECRET_FILE="$TMP/secret.env" \
    "$TOOL_DIR/scripts/catchup.sh" "$TMP/config.json" 2>&1)" || true
check "catch-up reports the ready ticket" "yes" "$(printf '%s' "$out" | grep -q 'ADAM-920' && echo yes || echo no)"
check "catch-up starts the ready ticket" "$((before + 1))" "$(run_count)"
check "catch-up reports a dispatch" "yes" "$(printf '%s' "$out" | grep -q 'dispatched' && echo yes || echo no)"

out="$(PATH="$TMP/bin:$PATH" \
    JIRA_DISPATCH_URL="http://$addr/jira/hook" \
    JIRA_DISPATCH_SECRET_FILE="$TMP/secret.env" \
    "$TOOL_DIR/scripts/catchup.sh" "$TMP/config.json" 2>&1)" || true
check "catch-up is idempotent" "$((before + 1))" "$(run_count)"

# ---------------------------------------------------------------- result

printf '\nchecks passed: %d, failed: %d\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
    printf '\n--- receiver log tail ---\n'
    tail -30 "$TMP/stderr.log"
    exit 1
fi
printf 'FINISH CONDITION PASSED\n'
