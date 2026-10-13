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

post_unsigned() { # body -> status code
    local body="$1"
    curl -sS -o "$TMP/last.json" -w '%{http_code}' \
        -H 'Content-Type: application/json' \
        --data-binary "$body" \
        "http://$addr/jira/hook"
}

post_wrong_secret() { # body -> status code
    local body="$1" sig
    sig="$(sign "$body" "$OTHER_SECRET")"
    curl -sS -o "$TMP/last.json" -w '%{http_code}' \
        -H "X-Hub-Signature: sha256=$sig" \
        -H 'Content-Type: application/json' \
        --data-binary "$body" \
        "http://$addr/jira/hook"
}

payload() { # key event label actor changelog_id
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
  "changelog": {"id": "$5", "items": [{"field": "labels", "fromString": "", "toString": "$3"}]}
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

kind_of() { # response file -> the "kind" field
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kind"])' "$1"
}

wait_for() { # file pattern seconds
    local file="$1" pattern="$2" seconds="${3:-8}"
    local i
    for ((i = 0; i < seconds * 10; i++)); do
        if [ -f "$file" ] && grep -q -- "$pattern" "$file" 2>/dev/null; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

# ---------------------------------------------------------------- setup

cat >"$TMP/fake-launch.sh" <<'SH'
#!/usr/bin/env bash
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
      "prepare": ["/bin/sleep", "2"],
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

body="$(payload ADAM-900 jira:issue_assigned agent-ready "$ME" chg-1)"

code="$(post_unsigned "$body")"
check "unsigned request is rejected" "401" "$code"
check "unsigned request starts nothing" "0" "$(run_count)"

code="$(post_wrong_secret "$body")"
check "wrongly signed request is rejected" "401" "$code"

code="$(post "$body")"
check "work mode off: accepted but ignored" "200" "$code"
check "work mode off: nothing started" "0" "$(run_count)"
check "work mode off: reason reported" "ignored" "$(kind_of "$TMP/last.json")"

touch "$WORKMODE"

code="$(post "$body")"
check "valid event: accepted" "202" "$code"
check "valid event: one run recorded" "1" "$(run_count)"
check "valid event: prompt file holds the key" "yes" "$(grep -l 'ADAM-900' "$STATE"/spool/*.prompt.txt >/dev/null 2>&1 && echo yes || echo no)"
check "valid event: prompt holds the browse url" "yes" "$(grep -q 'https://example.atlassian.net/browse/ADAM-900' "$STATE"/spool/*.prompt.txt && echo yes || echo no)"

# The prepare command sleeps, so the ticket lock is held across the next two
# checks. Both must land inside that window.
code="$(post "$body")"
check "duplicate event id: accepted but not started" "200" "$code"
check "duplicate event id: reported as duplicate" "duplicate" "$(kind_of "$TMP/last.json")"
check "duplicate event id: still one run" "1" "$(run_count)"

second="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-2)"
code="$(post "$second")"
check "same ticket while in flight: accepted but not started" "200" "$code"
check "same ticket while in flight: reported as in-flight" "in-flight" "$(kind_of "$TMP/last.json")"
check "same ticket while in flight: no second run" "1" "$(run_count)"

if wait_for "$DISPATCH_LOG" "launched key=ADAM-900"; then
    check "valid event: launch command ran" "yes" "yes"
else
    check "valid event: launch command ran" "yes" "no"
fi
check "valid event: {prompt} reached the launch command" "yes" "$(grep -q 'Ticket ADAM-900' "$DISPATCH_LOG" && echo yes || echo no)"

# Wrong actor.
foreign="$(payload ADAM-901 jira:issue_assigned agent-ready someone-else@example.com chg-3)"
code="$(post "$foreign")"
check "foreign actor: accepted but ignored" "200" "$code"
check "foreign actor: nothing started" "1" "$(run_count)"

# Missing trigger label.
unlabeled="$(payload ADAM-902 jira:issue_assigned some-other-label "$ME" chg-4)"
code="$(post "$unlabeled")"
check "missing trigger label: ignored" "200" "$code"
check "missing trigger label: nothing started" "1" "$(run_count)"

# Unknown project.
unknown="$(payload OTHER-903 jira:issue_assigned agent-ready "$ME" chg-5)"
code="$(post "$unknown")"
check "unknown project: ignored" "200" "$code"
check "unknown project: nothing started" "1" "$(run_count)"

# A different ticket has its own lock, so it starts while ADAM-900 is quiet.
other="$(payload ADAM-910 jira:issue_assigned agent-ready "$ME" chg-6)"
code="$(post "$other")"
check "a different ticket starts" "202" "$code"
check "a different ticket: second run recorded" "2" "$(run_count)"

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

# Running it again on the same revision must change nothing.
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
