# jira-dispatch

Turn a Jira webhook into one OpenCode session.

You mark a ticket ready. Jira sends a webhook. This receiver checks the event,
records it, and starts an OpenCode session on that ticket. The session runs
unattended and reports back as a comment on the ticket.

## Why a webhook and not a poll

A poll asks Atlassian for work on a timer. A webhook asks nothing and speaks
only when something happens. The trade is an always-on endpoint: a webhook
delivered while the receiver is down is lost. This receiver runs on the work
Mac, so "the Mac is off" and "I am not at work" are the same thing, which is
the behaviour you want.

## The trigger

Jira fires assignment events for many reasons: reassignment, bulk edits, sprint
changes. Reacting to all of them starts sessions you did not ask for.

This receiver is opt-in twice:

1. The issue must carry one of `triggerLabels`, for example `agent-ready`.
2. The actor must be in `allowedActors`.

Both defaults are in `config.example.json`. Add the label in Jira when you want
the agent to pick the ticket up. Remove it when you do not.

## What happens to one accepted event

```
POST /jira/hook
  verify X-Hub-Signature (HMAC-SHA256, constant time)
  parse, then filter: work mode, event type, actor, label, project mapping
  dedupe by event id          -> duplicate, stop
  take the per-ticket lock    -> in-flight, stop
  write the run record, prompt and raw payload
  answer Jira 202
  ... then, in the background:
  run `prepare`               (for ADAM: scripts/ws-start.sh <KEY>)
  start `launch` detached     (opencode run, one session titled <KEY>)
  drop the lock
```

The response is sent before the session runs, because Jira times out a slow
endpoint. The run record on disk is the durable evidence that a ticket was
dispatched.

## Install

```bash
./scripts/install.sh          # build, write config, load the launchd agent
```

Then:

```bash
# 1. the webhook secret
$EDITOR ~/.config/jira-dispatch/secret.env

# 2. the project mapping and the trigger
$EDITOR ~/.config/jira-dispatch/config.json

# 3. allow runs
./scripts/work-mode.sh on

# 4. expose the port to Jira. This is public HTTPS, so opt in deliberately.
tailscale funnel --bg 8787

# 5. in Jira: Settings -> System -> Webhooks -> Create
#    URL:    https://<your-machine>.<tailnet>.ts.net/jira/hook
#    Secret: the same value as in secret.env
#    Events: Issue -> created, updated (assigned/deleted not required)

# 6. check
curl -s http://127.0.0.1:8787/healthz
```

## Config

| Key | Meaning |
| --- | --- |
| `listen` | Address to bind. Keep it on `127.0.0.1`; Tailscale does the exposure. |
| `secretEnv` | Name of the environment variable that holds the webhook secret. |
| `stateDir` | Run records, prompts, spooled payloads, logs, seen set, locks. |
| `workModePath` | Marker file. When absent, the receiver accepts events and starts nothing. |
| `jiraBaseUrl` | Used to build the ticket link inside the prompt. |
| `allowedActors` | Emails or account ids allowed to trigger a run. Empty means any. |
| `allowedEvents` | Accepted `webhookEvent` values. Empty means any. |
| `triggerLabels` | The issue must carry one of these. Empty means any. |
| `lockTtlHours` | How long one ticket stays single-flight. |
| `projects` | Per project key: `workspace`, `prepareDir`, `prepare`, `launch`, `promptTemplate`. |

Placeholders: `{key}`, `{project}`, `{summary}`, `{url}`, `{workspace}`.
`launch` may also use `{prompt}`, which is the rendered template as a single
argument. Commands run argv-style, without a shell, so a value cannot change
the shape of the command.

## Project mapping for ADAM

`~/Documents/adam/scripts/ws-start.sh` already does the right thing for a
ticket: it adds the `pim` and `pim-ui` worktrees, indexes each into
codebase-memory as `pim-<KEY>` and `pim-ui-<KEY>`, and links them. The example
config calls it as `prepare` and runs the session in `ws.<KEY>`.

**These scripts are currently deleted in the `~/Documents/adam` working tree.**
`git -C ~/Documents/adam status` shows `D scripts/...`. They exist in the last
commit. Restore them before the first real run, or point `prepare` at
something else:

```bash
git -C ~/Documents/adam checkout -- scripts templates AGENTS.md README.md .gitignore
```

That command discards uncommitted deletions. Check `git status` first.

## Files the receiver writes

```
~/.local/state/jira-dispatch/
  seen/<sha256 of event id>.json    dedupe marker
  lock/<KEY>                        per-ticket single-flight
  runs/<ts>.<KEY>.json              the run record, with the exact argv
  spool/<KEY>.<ts>.json             the raw webhook body
  spool/<KEY>.<ts>.prompt.txt       the rendered prompt
  logs/<KEY>.<ts>.log               prepare output and the session log
```

## Test

```bash
go test ./...        # pure functions: signature, filters, substitution
./test/run.sh        # end to end: real HTTP server, signed payloads, fake launch
```

`test/run.sh` needs no Jira and no OpenCode. It starts the receiver on a free
port, sends signed and unsigned payloads, and asserts what was started.

## Known gaps

- The session is created with `--title <KEY>`. A second run on the same ticket
  creates a second session. `lockTtlHours` and the dedupe set cover the common
  case; resolving the title to an existing session id is not implemented.
- No startup catch-up. An event delivered while the receiver was down is lost.
  The fix is one JQL query at start, not a poll.
- `launch` output is not collected back. The session reports by commenting on
  the ticket.
- The cross-repo `prepare` step takes 10-15s. The webhook has already answered
  by then.
