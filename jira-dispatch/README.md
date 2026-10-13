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

An update starts a run only when the change **added** the label. A comment, a
summary edit, or any other change is ignored. This matters: the session
comments on its own ticket as you, so without that rule the session would
trigger itself and loop. A fresh assignment starts a run with no label change
needed, which is the common case.

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
  run `prepare` when set
  start `launch` detached     (opencode run, one session titled <KEY>)
  wait for the session, then drop the lock
```

The response is sent before the session runs, because Jira times out a slow
endpoint. The run record on disk is the durable evidence that a ticket was
dispatched. The lock is held for the whole session, so a second event on the
same ticket is refused while the first session runs.

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

# 7. pick up anything that became ready while the receiver was down
./scripts/catchup.sh
```

## Config

| Key | Meaning |
| --- | --- |
| `listen` | Address to bind. Keep it on `127.0.0.1`; Tailscale does the exposure. |
| `secretEnv` | Name of the environment variable that holds the webhook secret. |
| `stateDir` | Run records, prompts, spooled payloads, logs, seen set, locks. |
| `workModePath` | Marker file. When absent, the receiver accepts events and starts nothing. |
| `jiraBaseUrl` | Used to build the ticket link inside the prompt. |
| `allowedActors` | Emails or account ids allowed to trigger a run. Must not be empty. |
| `allowedEvents` | Accepted `webhookEvent` values. Empty means any. |
| `triggerLabels` | The issue must carry one of these. Empty means any. |
| `lockTtlHours` | A lock older than this is stale and is taken over. It covers a receiver that died mid-session, not the length of a run. |
| `projects` | Per project key: `workspace`, `launch` and `promptTemplate` are required; `prepare` and `prepareDir` are optional. |

Placeholders: `{key}`, `{project}`, `{summary}`, `{url}`, `{workspace}`.
`launch` may also use `{prompt}`, which is the rendered template as a single
argument. Commands run argv-style, without a shell, so a value cannot change
the shape of the command.

## Project mapping

`prepare` is optional. Leave it out and the session starts in `workspace` with
no setup. The agent then decides for itself whether the ticket needs a worktree,
which is the default in `config.example.json`.

The trade: an empty `prepare` gives the decision to the session, and the
receiver no longer guarantees isolation. If the agent works in the shared
checkout, two tickets can collide. The prompt template asks it to say which it
chose, so the run record and the ticket comment show the answer.

Use `prepare` when a ticket class always needs the same setup, for example a
worktree, a dependency install, or a generated file. The receiver runs it once
before the session and stops the run when it fails.

```json
"prepare": ["git", "-C", "~/Documents/adam/airrlabs-mono", "worktree", "add", "{workspace}", "-b", "feat/{key}"]
```

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

- The session is created with `--title <KEY>`. The ticket lock and the label
  rule stop a second session while one runs, but a new hand-off after the first
  session ends creates a second session rather than continuing the first.
  Resolving the title to an existing session id is not implemented.
- The catch-up is not automatic. Run `scripts/catchup.sh` by hand, or when the
  receiver starts, to pick up tickets that became ready while it was down.
- `launch` output is not collected back. The session reports by commenting on
  the ticket.
- `prepare` runs before the session, so a slow one delays the session start. It
  does not delay the webhook response, and the lock is held for the whole run.
- There is no anti-replay check on a signed body. The webhook secret is the
  trust boundary, so a replay already requires the secret, which allows
  forging any event.
