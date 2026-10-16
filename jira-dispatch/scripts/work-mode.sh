#!/usr/bin/env bash
# Turn the work-mode marker on or off. The receiver starts sessions only while
# the marker exists, so this is the switch for "I am at work" and "I am not".
#
# Usage: work-mode.sh [on|off|status]
set -euo pipefail

readonly MARKER="${JIRA_DISPATCH_WORK_MODE:-$HOME/.local/state/agent-work-mode}"

case "${1:-status}" in
    on)
        mkdir -p "$(dirname "$MARKER")"
        : >"$MARKER"
        printf 'work mode on (%s)\n' "$MARKER"
        ;;
    off)
        rm -f "$MARKER"
        printf 'work mode off\n'
        ;;
    status)
        if [ -e "$MARKER" ]; then
            printf 'work mode on\n'
        else
            printf 'work mode off\n'
        fi
        ;;
    *)
        printf 'usage: work-mode.sh [on|off|status]\n' >&2
        exit 2
        ;;
esac
