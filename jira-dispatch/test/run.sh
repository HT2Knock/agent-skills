#!/usr/bin/env bash
# End-to-end check for the jira-dispatch receiver.
#
# Runs offline: no Jira and no real OpenCode. The OpenCode server is replaced by
# a fake that records every request, so the check proves what the receiver asked
# for, not just that it returned a status code.
#
# Usage: test/run.sh
set -euo pipefail

readonly TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TMP="$(mktemp -d)"
readonly SECRET="test-secret-value"
readonly OTHER_SECRET="a-different-secret"
readonly FAKE_LOG="$TMP/fake-opencode.log"
readonly STATE="$TMP/state"
readonly WORKMODE="$TMP/workmode"
readonly ME="ngoc@example.com"

pass=0
fail=0
receiver_pid=""
fake_pid=""
addr=""
fake_url=""

cleanup() {
    for pid in "$receiver_pid" "$fake_pid"; do
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
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

has() { # logfile pattern -> yes/no
    if [ -f "$1" ] && grep -qF -- "$2" "$1" 2>/dev/null; then printf 'yes'; else printf 'no'; fi
}

sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$2" | awk '{print $NF}'; }

post() { # body -> status code; response body lands in $TMP/last.json
    local sig
    sig="$(sign "$1" "$SECRET")"
    curl -sS -o "$TMP/last.json" -w '%{http_code}' \
        -H "X-Hub-Signature: sha256=$sig" \
        -H 'Content-Type: application/json' \
        --data-binary "$1" "http://$addr/jira/hook"
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

record_field() { # field name from the newest run record
    python3 -c '
import glob, json, os, sys
files = sorted(glob.glob(sys.argv[1]), key=os.path.getmtime)
print(json.load(open(files[-1]))[sys.argv[2]] if files else "")
' "$STATE/runs/*.json" "$1"
}

wait_for() { # file pattern seconds
    local i
    for ((i = 0; i < ${3:-8} * 10; i++)); do
        if [ -f "$1" ] && grep -qF -- "$2" "$1" 2>/dev/null; then return 0; fi
        sleep 0.1
    done
    return 1
}

wait_gone() { # path seconds
    local i
    for ((i = 0; i < ${2:-8} * 10; i++)); do
        if [ ! -e "$1" ]; then return 0; fi
        sleep 0.1
    done
    return 1
}

present() { if [ -e "$1" ]; then printf 'yes'; else printf 'no'; fi; }

# ---------------------------------------------------------------- setup

printf '' >"$FAKE_LOG"
export FAKE_LOG
FAKE_WAIT_MS=2000 bun run "$TOOL_DIR/test/fake-opencode.ts" >"$TMP/fake.out" 2>"$TMP/fake.err" &
fake_pid=$!

for _ in $(seq 1 100); do
    fake_url="$(sed -n 's|^fake opencode on ||p' "$TMP/fake.out" | head -1)"
    if [ -n "$fake_url" ]; then break; fi
    sleep 0.1
done
if [ -z "$fake_url" ]; then
    printf 'FATAL: the fake OpenCode server did not start\n'
    cat "$TMP/fake.err"
    exit 1
fi
printf 'fake opencode on %s\n' "$fake_url"

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
  "opencode": {
    "baseUrl": "$fake_url",
    "model": { "providerID": "anthropic", "id": "claude-sonnet-5-5", "variant": "high" }
  },
  "projects": {
    "ADAM": {
      "workspace": "$TMP/ws/{key}",
      "prepareDir": "$TMP",
      "prepare": ["/usr/bin/true"],
      "promptTemplate": "Ticket {key}: {summary}\nURL: {url}\nWorkspace: {workspace}\nwork the ticket fully."
    },
    "LEAN": {
      "workspace": "$TMP/ws-lean/{key}"
    }
  }
}
JSON

export TEST_WEBHOOK_SECRET="$SECRET"
export JIRA_DISPATCH_CONFIG="$TMP/config.json"
bun run "$TOOL_DIR/src/cli.ts" serve >"$TMP/stdout.log" 2>"$TMP/stderr.log" &
receiver_pid=$!

for _ in $(seq 1 100); do
    addr="$(sed -n 's|^listening on http://||p' "$TMP/stdout.log" | head -1)"
    if [ -n "$addr" ]; then break; fi
    sleep 0.1
done
if [ -z "$addr" ]; then
    printf 'FATAL: the receiver did not report a listening address\n'
    cat "$TMP/stderr.log"
    exit 1
fi
printf 'receiver on %s\n\n' "$addr"

# ---------------------------------------------------------------- checks

check "health endpoint answers" "200" "$(curl -sS -o /dev/null -w '%{http_code}' "http://$addr/healthz")"

offmode="$(payload ADAM-900 jira:issue_assigned agent-ready "$ME" chg-off labels agent-ready)"
check "work mode off: accepted but ignored" "200" "$(post "$offmode")"
check "work mode off: reported as ignored" "ignored" "$(kind_of)"
check "work mode off: nothing started" "0" "$(run_count)"

touch "$WORKMODE"

check "unsigned request is rejected" "401" "$(post_unsigned "$offmode")"
check "unsigned request starts nothing" "0" "$(run_count)"
check "wrongly signed request is rejected" "401" "$(post_wrong_secret "$offmode")"
check "wrongly signed request starts nothing" "0" "$(run_count)"

first="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-1 labels agent-ready)"
check "label added: accepted" "202" "$(post "$first")"
check "label added: reported as dispatched" "dispatched" "$(kind_of)"
check "label added: one run recorded" "1" "$(run_count)"

check "workspace placeholder is expanded" "$TMP/ws/ADAM-900" "$(record_field workspace)"
check "workspace directory exists" "yes" "$(present "$TMP/ws/ADAM-900")"
check "prompt file holds the key" "yes" "$(grep -q 'ADAM-900' "$STATE"/spool/*.prompt.txt && echo yes || echo no)"
check "prompt holds the browse url" "yes" "$(grep -q 'https://example.atlassian.net/browse/ADAM-900' "$STATE"/spool/*.prompt.txt && echo yes || echo no)"
check "prompt holds the expanded workspace" "yes" "$(grep -q "$TMP/ws/ADAM-900" "$STATE"/spool/*.prompt.txt && echo yes || echo no)"

# The session is running and the fake server is sleeping. Both of these must
# land inside it.
check "duplicate event id: reported as duplicate" "duplicate" "$(post "$first" >/dev/null; kind_of)"
check "duplicate event id: still one run" "1" "$(run_count)"

inflight="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-2 labels agent-ready)"
post "$inflight" >/dev/null
check "same ticket while the session runs: reported in-flight" "in-flight" "$(kind_of)"
check "same ticket while the session runs: no second run" "1" "$(run_count)"
check "ticket lock is held while the session runs" "yes" "$(present "$STATE/lock/ADAM-900")"

if wait_for "$FAKE_LOG" "POST /api/session "; then
    check "a session was created" "yes" "yes"
else
    check "a session was created" "yes" "no"
fi
check "session title is the ticket key" "yes" "$(has "$FAKE_LOG" '"title":"ADAM-900"')"
check "the configured model is passed to the session" "yes" "$(has "$FAKE_LOG" '"model":{"providerID":"anthropic","id":"claude-sonnet-5-5","variant":"high"}')"
check "session location is the expanded workspace" "yes" "$(has "$FAKE_LOG" "\"directory\":\"$TMP/ws/ADAM-900\"")"
check "the prompt was sent to the session" "yes" "$(has "$FAKE_LOG" "work the ticket fully")"
check "the prompt carried the ticket summary" "yes" "$(has "$FAKE_LOG" "Ticket ADAM-900: Fix the assortment variant")"

if wait_for "$FAKE_LOG" "/wait"; then
    check "the receiver waited for the session" "yes" "yes"
else
    check "the receiver waited for the session" "yes" "no"
fi
if wait_gone "$STATE/lock/ADAM-900"; then
    check "ticket lock is released when the session ends" "yes" "yes"
else
    check "ticket lock is released when the session ends" "yes" "no"
fi

owncomment="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-3 comment "opened a draft PR")"
check "a comment on the ticket is ignored" "ignored" "$(post "$owncomment" >/dev/null; kind_of)"
check "a comment on the ticket starts nothing" "1" "$(run_count)"

edited="$(payload ADAM-900 jira:issue_updated agent-ready "$ME" chg-4 summary "A new summary")"
check "a non-label edit is ignored" "ignored" "$(post "$edited" >/dev/null; kind_of)"
check "a non-label edit starts nothing" "1" "$(run_count)"

assigned="$(payload ADAM-911 jira:issue_assigned agent-ready "$ME" chg-5 labels agent-ready)"
check "a fresh assignment starts" "202" "$(post "$assigned")"
check "a fresh assignment: second run recorded" "2" "$(run_count)"

foreign="$(payload ADAM-901 jira:issue_assigned agent-ready someone-else@example.com chg-6 labels agent-ready)"
check "foreign actor: reported as ignored" "ignored" "$(post "$foreign" >/dev/null; kind_of)"
check "foreign actor: nothing started" "2" "$(run_count)"

unlabeled="$(payload ADAM-902 jira:issue_assigned some-other-label "$ME" chg-7 labels some-other-label)"
check "missing trigger label: reported as ignored" "ignored" "$(post "$unlabeled" >/dev/null; kind_of)"
check "missing trigger label: nothing started" "2" "$(run_count)"

unknown="$(payload OTHER-903 jira:issue_assigned agent-ready "$ME" chg-8 labels agent-ready)"
check "unknown project: reported as ignored" "ignored" "$(post "$unknown" >/dev/null; kind_of)"
check "unknown project: nothing started" "2" "$(run_count)"

lean="$(payload LEAN-904 jira:issue_assigned agent-ready "$ME" chg-9 labels agent-ready)"
check "a project with no prepare still starts" "202" "$(post "$lean")"
check "a project with no prepare: one run" "3" "$(run_count)"
check "no promptTemplate: the default prompt names the ticket" "yes" "$(grep -q 'LEAN-904' "$STATE"/spool/LEAN-904.*.prompt.txt && echo yes || echo no)"
check "no promptTemplate: the default prompt points at the skills" "yes" "$(grep -q 'autonomous-run' "$STATE"/spool/LEAN-904.*.prompt.txt && echo yes || echo no)"

# ---------------------------------------------------------------- catch-up

mkdir -p "$TMP/bin"
cat >"$TMP/bin/atlassian-cli" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_CALLS:-/dev/null}"
for arg in "$@"; do
    case "$arg" in
        */changelog*) cat "${FAKE_CHANGELOG:-/dev/null}"; exit 0 ;;
    esac
done
cat "${FAKE_SEARCH:-/dev/null}"
EOF
chmod +x "$TMP/bin/atlassian-cli"
cat >"$TMP/catchup-search.json" <<EOF
[{"key":"ADAM-920","summary":"Catch-up ticket","labels":["agent-ready"],"updated":"2026-10-13T09:00:00.000+0700","assignee":{"emailAddress":"$ME"}}]
EOF
printf 'TEST_WEBHOOK_SECRET=%s\n' "$SECRET" >"$TMP/secret.env"

before="$(run_count)"
out="$(PATH="$TMP/bin:$PATH" FAKE_SEARCH="$TMP/catchup-search.json" \
    JIRA_DISPATCH_URL="http://$addr/jira/hook" \
    JIRA_DISPATCH_SECRET_FILE="$TMP/secret.env" \
    bun run "$TOOL_DIR/src/cli.ts" catchup --config "$TMP/config.json" 2>&1)" || true
check "catch-up reports the ready ticket" "yes" "$(printf '%s' "$out" | grep -q 'ADAM-920' && echo yes || echo no)"
check "catch-up starts the ready ticket" "$((before + 1))" "$(run_count)"
check "catch-up reports a dispatch" "yes" "$(printf '%s' "$out" | grep -q 'dispatched' && echo yes || echo no)"

out="$(PATH="$TMP/bin:$PATH" FAKE_SEARCH="$TMP/catchup-search.json" \
    JIRA_DISPATCH_URL="http://$addr/jira/hook" \
    JIRA_DISPATCH_SECRET_FILE="$TMP/secret.env" \
    bun run "$TOOL_DIR/src/cli.ts" catchup --config "$TMP/config.json" 2>&1)" || true
check "catch-up is idempotent" "$((before + 1))" "$(run_count)"

# ---------------------------------------------------------------- poll

issue_json() { # key id updated -> one search result
    cat <<JSON
[{"key":"$1","summary":"Poll ticket $1","labels":["agent-ready"],"updated":"$3","assignee":{"emailAddress":"$ME"}}]
JSON
}

poll() {
    PATH="$TMP/bin:$PATH" \
        FAKE_SEARCH="$TMP/poll-search.json" \
        FAKE_CHANGELOG="$TMP/poll-changelog.json" \
        FAKE_CALLS="$TMP/poll-calls.log" \
        JIRA_DISPATCH_URL="http://$addr/jira/hook" \
        JIRA_DISPATCH_SECRET_FILE="$TMP/secret.env" \
        bun run "$TOOL_DIR/src/cli.ts" poll --config "$TMP/config.json" "$@" 2>&1
}

issue_json ADAM-930 10003 2026-10-19T10:00:00.000+0700 >"$TMP/poll-search.json"
cat >"$TMP/poll-changelog.json" <<EOF
{"startAt":0,"maxResults":100,"total":2,"values":[
  {"id":"5001","created":"2026-10-19T10:00:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"labels","fromString":"","toString":"agent-ready"}]},
  {"id":"5002","created":"2026-10-19T10:05:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"comment","fromString":"","toString":"a comment"}]}
]}
EOF

poll_base="$(run_count)"
printf '' >"$TMP/poll-calls.log"
out="$(poll)" || true
check "poll reports the ready ticket" "yes" "$(printf '%s' "$out" | grep -q 'ADAM-930' && echo yes || echo no)"
check "poll starts the ready ticket" "$((poll_base + 1))" "$(run_count)"
check "poll reports a dispatch" "yes" "$(printf '%s' "$out" | grep -q 'dispatched' && echo yes || echo no)"
check "poll writes a state file" "yes" "$(present "$STATE/poll.json")"
check "poll records a cursor" "yes" "$(python3 -c 'import json,sys;print("yes" if json.load(open(sys.argv[1])).get("lastPassAt") else "no")' "$STATE/poll.json")"
check "poll releases its lock" "no" "$(present "$STATE/poll.lock")"
check "the first pass asks for every ready ticket" "no" "$(grep -q 'updated >=' "$TMP/poll-calls.log" && echo yes || echo no)"
wait_gone "$STATE/lock/ADAM-930"

# The same updated value must not fetch the changelog again.
printf '' >"$TMP/poll-calls.log"
out="$(poll)" || true
check "poll skips an unchanged ticket" "yes" "$(printf '%s' "$out" | grep -q '1 unchanged' && echo yes || echo no)"
check "unchanged ticket: no changelog request" "0" "$(grep -c '/changelog' "$TMP/poll-calls.log" || true)"
check "poll still one run" "$((poll_base + 1))" "$(run_count)"
check "a later pass asks only for changes" "yes" "$(grep -q 'updated >=' "$TMP/poll-calls.log" && echo yes || echo no)"

# The session comments on the ticket, which changes updated and adds a
# changelog entry. Only the label add may trigger a run.
issue_json ADAM-930 10003 2026-10-19T10:10:00.000+0700 >"$TMP/poll-search.json"
cat >"$TMP/poll-changelog.json" <<EOF
{"startAt":0,"maxResults":100,"total":3,"values":[
  {"id":"5001","created":"2026-10-19T10:00:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"labels","fromString":"","toString":"agent-ready"}]},
  {"id":"5002","created":"2026-10-19T10:05:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"comment","fromString":"","toString":"a comment"}]},
  {"id":"5003","created":"2026-10-19T10:10:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"comment","fromString":"","toString":"reported back"}]}
]}
EOF
printf '' >"$TMP/poll-calls.log"
out="$(poll)" || true
check "a later comment does not start a run" "$((poll_base + 1))" "$(run_count)"
check "a later comment reports the same label add" "yes" "$(printf '%s' "$out" | grep -q 'already handled 5001' && echo yes || echo no)"
check "a later comment: one changelog request" "1" "$(grep -c '/changelog' "$TMP/poll-calls.log" || true)"

wait_gone "$STATE/lock/ADAM-930"
issue_json ADAM-930 10003 2026-10-19T10:15:00.000+0700 >"$TMP/poll-search.json"
cat >"$TMP/poll-changelog.json" <<EOF
{"startAt":0,"maxResults":100,"total":4,"values":[
  {"id":"5001","created":"2026-10-19T10:00:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"labels","fromString":"","toString":"agent-ready"}]},
  {"id":"5002","created":"2026-10-19T10:05:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"comment","fromString":"","toString":"a comment"}]},
  {"id":"5003","created":"2026-10-19T10:10:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"comment","fromString":"","toString":"reported back"}]},
  {"id":"5004","created":"2026-10-19T10:15:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"labels","fromString":"urgent","toString":"agent-ready urgent"}]}
]}
EOF
out="$(poll)" || true
check "a second label add starts a new run" "$((poll_base + 2))" "$(run_count)"
check "a second label add is reported as dispatched" "yes" "$(printf '%s' "$out" | grep -q 'dispatched' && echo yes || echo no)"

issue_json ADAM-931 10004 2026-10-19T10:20:00.000+0700 >"$TMP/poll-search.json"
cat >"$TMP/poll-changelog.json" <<EOF
{"startAt":0,"maxResults":100,"total":1,"values":[
  {"id":"5005","created":"2026-10-19T10:20:00.000+0700","author":{"emailAddress":"someone-else@example.com"},"items":[{"field":"labels","fromString":"","toString":"agent-ready"}]}
]}
EOF
out="$(poll)" || true
check "poll honours the actor filter" "yes" "$(printf '%s' "$out" | grep -q 'ignored' && echo yes || echo no)"
check "poll actor filter: no run" "$((poll_base + 2))" "$(run_count)"

issue_json ADAM-932 10005 2026-10-19T10:25:00.000+0700 >"$TMP/poll-search.json"
cat >"$TMP/poll-changelog.json" <<EOF
{"startAt":0,"maxResults":100,"total":1,"values":[
  {"id":"5006","created":"2026-10-19T10:25:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"comment","fromString":"","toString":"no label change"}]}
]}
EOF
out="$(poll)" || true
check "no label-add history: skipped" "yes" "$(printf '%s' "$out" | grep -q 'no label-add history' && echo yes || echo no)"
check "no label-add history: no run" "$((poll_base + 2))" "$(run_count)"

issue_json ADAM-933 10006 2026-10-19T10:30:00.000+0700 >"$TMP/poll-search.json"
cat >"$TMP/poll-changelog.json" <<EOF
{"startAt":0,"maxResults":100,"total":1,"values":[
  {"id":"5007","created":"2026-10-19T10:30:00.000+0700","author":{"emailAddress":"$ME"},"items":[{"field":"labels","fromString":"","toString":"agent-ready"}]}
]}
EOF
out="$(poll --dry-run)" || true
check "poll dry run posts nothing" "$((poll_base + 2))" "$(run_count)"
check "poll dry run names the changelog id" "yes" "$(printf '%s' "$out" | grep -q 'would post 5007' && echo yes || echo no)"

# ---------------------------------------------------------------- work-mode CLI

check "work-mode reports the marker on" "work mode on" "$(bun run "$TOOL_DIR/src/cli.ts" work-mode status --config "$TMP/config.json")"
bun run "$TOOL_DIR/src/cli.ts" work-mode off --config "$TMP/config.json" >/dev/null
check "work-mode off removes the marker" "no" "$(present "$WORKMODE")"
bun run "$TOOL_DIR/src/cli.ts" work-mode on --config "$TMP/config.json" >/dev/null
check "work-mode on writes the marker" "yes" "$(present "$WORKMODE")"

# ---------------------------------------------------------------- install

HOME="$TMP/home" JIRA_DISPATCH_SECRET_FILE="$TMP/home/secret.env" \
    bun run "$TOOL_DIR/src/cli.ts" install --config "$TMP/home/config.json" --dry-run >"$TMP/install.out" 2>&1
check "install writes a config" "yes" "$(present "$TMP/home/config.json")"
check "install config has no promptTemplate" "no" "$(grep -q promptTemplate "$TMP/home/config.json" && echo yes || echo no)"
check "install writes the launchd plist" "yes" "$(present "$TMP/home/Library/LaunchAgents/com.ht2knock.jira-dispatch.plist")"
check "install writes the poll launchd plist" "yes" "$(present "$TMP/home/Library/LaunchAgents/com.ht2knock.jira-dispatch-poll.plist")"
check "install poll agent watches" "yes" "$(grep -q -- '--watch' "$TMP/home/Library/LaunchAgents/com.ht2knock.jira-dispatch-poll.plist" && echo yes || echo no)"
check "install poll agent stays alive" "yes" "$(grep -q 'KeepAlive' "$TMP/home/Library/LaunchAgents/com.ht2knock.jira-dispatch-poll.plist" && echo yes || echo no)"
check "install poll agent has no fixed interval" "no" "$(grep -q 'StartInterval' "$TMP/home/Library/LaunchAgents/com.ht2knock.jira-dispatch-poll.plist" && echo yes || echo no)"

# ---------------------------------------------------------------- result

printf '\nchecks passed: %d, failed: %d\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
    printf '\n--- receiver log tail ---\n'
    tail -25 "$TMP/stderr.log"
    printf '\n--- opencode requests ---\n'
    cut -c1-160 "$FAKE_LOG"
    exit 1
fi
printf 'FINISH CONDITION PASSED\n'
