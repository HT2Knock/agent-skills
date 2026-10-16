#!/usr/bin/env bash
# Build the receiver and install it as a launchd agent.
#
# This does not start a Jira webhook. It does not open a public endpoint.
# Both are separate, deliberate steps (see README.md).
#
# Usage: install.sh
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO="$(cd "$HERE/.." && pwd)"
readonly LABEL="com.ht2knock.jira-dispatch"
readonly PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
readonly CONFIG_DIR="$HOME/.config/jira-dispatch"

log() {
    printf '[install] %s\n' "$*"
}

log "building $REPO/bin/jira-dispatch"
mkdir -p "$REPO/bin"
(cd "$REPO" && go build -trimpath -o bin/jira-dispatch .)

mkdir -p "$CONFIG_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
    cp "$REPO/config.example.json" "$CONFIG_DIR/config.json"
    log "wrote $CONFIG_DIR/config.json -- edit it: project mapping, actor, labels"
else
    log "$CONFIG_DIR/config.json already exists, leaving it alone"
fi

if [ ! -f "$CONFIG_DIR/secret.env" ]; then
    printf 'JIRA_WEBHOOK_SECRET=\n' >"$CONFIG_DIR/secret.env"
    chmod 600 "$CONFIG_DIR/secret.env"
    log "wrote $CONFIG_DIR/secret.env -- put the Jira webhook secret in it"
else
    log "$CONFIG_DIR/secret.env already exists, leaving it alone"
fi

sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
    "$REPO/launchd/$LABEL.plist.tmpl" >"$PLIST"
log "wrote $PLIST"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    log "reloading the agent"
    launchctl bootout "gui/$(id -u)/$LABEL" || true
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"
log "agent loaded"

log ""
log "next:"
log "  1. put the webhook secret in $CONFIG_DIR/secret.env"
log "  2. edit $CONFIG_DIR/config.json"
log "  3. ./scripts/work-mode.sh on"
log "  4. expose the port: tailscale funnel --bg 8787"
log "  5. create the Jira webhook with that URL and the same secret"
log "  6. check: curl -s http://127.0.0.1:8787/healthz"
