# jira-dispatch

Turn a Jira trigger into one OpenCode session.

You mark a ticket ready. A Jira webhook, or a poll of the ticket changelog,
reaches this receiver. It checks the event, records it, and drives an OpenCode
session on that ticket through the OpenCode client. The session runs unattended
and reports back as a comment on the ticket.

## Commands

```
jira-dispatch serve                     run the webhook receiver (default)
jira-dispatch poll                      dispatch tickets whose changelog shows a new trigger label
jira-dispatch catchup                   dispatch tickets that became ready while the receiver was down
jira-dispatch work-mode [on|off|status] turn unattended runs on or off
jira-dispatch install                   write the config, the secret file and the launchd agents
jira-dispatch help
```

`--config <path>` selects the config file. The default is
`~/.config/jira-dispatch/config.json`, or `JIRA_DISPATCH_CONFIG` when set.

Run from a source checkout with `bun run src/cli.ts <command>`, or build the
single binary and run `dist/jira-dispatch <command>`.

## Why the client and not a shell command

An earlier version ran `opencode run` as a child process and matched sessions by
title. This version uses `@opencode/client`, the generated TypeScript client for
the OpenCode HTTP API. That gives:

- a typed session handle, instead of parsing a title out of `session list`
- `session.wait`, so the ticket lock is held until the session actually ends
- structured errors, instead of scraping a log for `[error]`

The receiver still answers Jira before the session runs, because Jira times out
a slow endpoint.

## The trigger

Jira fires assignment events for many reasons: reassignment, bulk edits, sprint
changes. Reacting to all of them starts sessions you did not ask for.

This receiver is opt-in twice:

1. The issue must carry one of `triggerLabels`, for example `agent-ready`.
2. The actor must be in `allowedActors`.

An update starts a run only when the change **added** the label. A comment, a
summary edit, or any other change is ignored. This matters: the session comments
on its own ticket as you, so without that rule the session would trigger itself
and loop. A fresh assignment starts a run with no label change needed.

### Without a Jira admin

A Jira Cloud admin webhook needs the global **Administer Jira** permission, and
the dynamic webhook API (`/rest/api/3/webhook`) is open only to Connect and
OAuth 2.0 apps. A normal user cannot create either. An API token cannot exceed
the permissions of the account that owns it.

`poll` covers that case. It reads the changelog of each ready ticket and
dispatches once per label add. A later comment or summary edit is not a label
add, so it does not loop. `poll` also uses the same read access as `catchup`, so
no admin is involved.

Polling is incremental and adaptive:

- It stores the time of the last successful search and asks Jira only for issues
  changed since then, with a five-minute overlap for clock skew.
- It caches each ticket's `updated` value and the changelog id it already
  dispatched. An unchanged ticket costs no changelog request, and a comment on a
  handled ticket does not post again.
- After a dispatch it polls every 60 seconds. Each empty pass backs off one step:
  120, 300, 600, then 900 seconds. Jitter is ±10%.
- A failed pass backs off from 120 seconds, doubles, and caps at 30 minutes. The
  cursor does not move on a failure, so the event is retried.
- A single-flight lock stops two poll passes from overlapping.

At the 900-second cap an idle machine makes 96 search requests per day, no
changelog requests, and the watch process sleeps between passes.

Both sources produce the same payload for the same change, including the Jira
changelog id. The receiver therefore dedupes a poll and a webhook delivery of the
same event, and the two can run together.

## One accepted event

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
  client.session.create({ title: <KEY>, location: workspace })
  client.session.prompt({ sessionID, text })
  client.session.wait({ sessionID }) then drop the lock
```

The run record on disk is the durable evidence that a ticket was dispatched. The
lock is held for the whole session, so a second event on the same ticket is
refused while the first session runs.

`poll` builds the same body for a label add, with the issue's real changelog id
as the event id. It posts to the same `/jira/hook` endpoint with the same HMAC
signature.

## Requirements

- Bun
- An OpenCode server. Either the local background service (the default) or a
  server named in `opencode.baseUrl`.
- `atlassian-cli` on `PATH` for `poll` and `catchup`.

## Install

```bash
bun run src/cli.ts install        # or, after a build: dist/jira-dispatch install
```

This writes the config, the secret file, and two launchd agents: the receiver,
and a watch poller that backs off from 60 seconds to 15 minutes. It does not
create a Jira webhook and it does not open a public endpoint. Both agents get a
`PATH` that includes `/opt/homebrew/bin` and `~/.local/bin`, so `atlassian-cli`
and `opencode` resolve under launchd. Then:

```bash
# 1. the webhook secret
$EDITOR ~/.config/jira-dispatch/secret.env

# 2. the project mapping and the trigger
$EDITOR ~/.config/jira-dispatch/config.json

# 3. allow runs
bun run src/cli.ts work-mode on

# 4. run a poll pass by hand to check the Jira read
bun run src/cli.ts poll --dry-run

# 5. only for a webhook: expose the port. Pick one.
opentunnel route add 8787
#   or, keeping it inside your tailnet tooling:
# tailscale funnel --bg --https=8443 8787

# 6. only for a webhook, and only a Jira admin can do this:
#    Settings -> System -> Webhooks -> Create
#    URL:    the public URL printed in step 5, with /jira/hook
#    Secret: the same value as in secret.env
#    Events: Issue -> assigned, updated

# 7. check
curl -s http://127.0.0.1:8787/healthz

# 8. pick up anything that became ready before the poll agent existed
bun run src/cli.ts catchup
```

The poll agent needs no admin and no tunnel. It reads Jira over the same token
that `catchup` uses. Leave step 5 out when you only poll. If an admin creates the
webhook later, both sources can run: the receiver dedupes them by changelog id.

The watch interval is adaptive: 60 seconds after a dispatch, then 120, 300, 600
and 900 seconds after each empty pass, with ±10% jitter. The installed agent
uses those defaults; change `minIntervalSeconds` and `maxIntervalSeconds` in
`src/poll.ts` and re-run `install` to change its band. A manual run also accepts
`--min-interval <s>` and `--max-interval <s>`, or the
`JIRA_DISPATCH_POLL_MIN` and `JIRA_DISPATCH_POLL_MAX` environment variables. The
watch process holds `poll.lock` for its lifetime; a manual `poll` exits when the
watch is running. Use `poll --dry-run` to inspect a pass without posting or
writing state.

### The secret

`serve` reads the secret from the named environment variable first. If it is
not set, it reads `~/.config/jira-dispatch/secret.env`, so the secret stays out
of the launchd plist. Point `JIRA_DISPATCH_SECRET_FILE` at another file to move
it.

### Exposing the port

**opentunnel** gives a random 16-character hostname and terminates TLS on this
machine, so the relay never holds the key. Read its trust boundary before you
rely on it:

- the URL is public, and the hostname is published to certificate transparency
  logs, so it is discoverable
- route names are private, not secret, and are guessable
- a tunneled request reaches the app as `127.0.0.1`, so the app must not treat
  tunneled traffic as local

The HMAC secret is the only gate on this endpoint. That is the point: keep the
secret strong, and remember `work-mode off` stops all runs without touching the
network.

**tailscale funnel** is the alternative if you would rather not add a service.
It needs Funnel enabled for the tailnet in the access-control policy. Do not run
bare `tailscale funnel 8787`: that targets the default 443 listener, which may
already serve the OpenCode UI. Pass `--https=8443`.

## Config

Only two keys have no default: `allowedActors` and `projects`. A minimal config
is:

```json
{
  "allowedActors": ["you@example.com"],
  "projects": {
    "ADAM": { "workspace": "~/Documents/adam" }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `listen` | `127.0.0.1:8787` | Address to bind. Keep it on `127.0.0.1`; the tunnel does the exposure. |
| `secretEnv` | `JIRA_WEBHOOK_SECRET` | Name of the environment variable that holds the webhook secret. |
| `stateDir` | `~/.local/state/jira-dispatch` | Run records, prompts, spooled payloads, logs, seen set, locks. |
| `workModePath` | `~/.local/state/agent-work-mode` | Marker file. When absent, the receiver accepts events and starts nothing. |
| `jiraBaseUrl` | none | Used to build the ticket link inside the prompt. |
| `allowedActors` | required | Emails or account ids allowed to trigger a run. Must not be empty. |
| `allowedEvents` | assigned, updated | Accepted `webhookEvent` values. Empty means any. |
| `triggerLabels` | `["agent-ready"]` | The issue must carry one of these. Empty means any. |

`poll` requires at least one `triggerLabels` entry. With an empty list it
refuses to run, because its JQL would then match every open ticket assigned to
you.
| `lockTtlHours` | `6` | A lock older than this is stale and is taken over. It covers a receiver that died mid-session, not the length of a run. |
| `opencode` | none | Optional. `baseUrl` names a server; `agent` and `model` are passed to `session.create`. |
| `projects` | required | Per project key. `workspace` is required; `promptTemplate`, `prepare` and `prepareDir` are optional. |

Placeholders: `{key}`, `{project}`, `{summary}`, `{url}`, `{workspace}`.
Substitution is a single pass, so a value that contains a placeholder is not
scanned again.

### The default prompt

Omit `promptTemplate` and the receiver sends a built-in prompt: the ticket, the
URL and the workspace, the two skills to use, and the branch rule. OpenCode
already loads the AGENTS.md files and advertises each skill by its description,
so the prompt does not repeat either. Set `promptTemplate` when a project needs
a different prompt.

## Project mapping

`prepare` is optional. Leave it out and the session starts in `workspace` with
no setup. The agent then decides for itself whether the ticket needs a worktree,
which is the default in `config.example.json`.

The trade: an empty `prepare` gives the decision to the session, and the
receiver no longer guarantees isolation. If the agent works in the shared
checkout, two tickets can collide. The prompt asks it to say which it chose, so
the run record and the ticket comment show the answer.

Use `prepare` when a ticket class always needs the same setup. It runs argv-style
without a shell, and a failure stops the run.

## Files the receiver writes

```
~/.local/state/jira-dispatch/
  seen/<sha256 of event id>.json    dedupe marker
  lock/<KEY>                        per-ticket single-flight
  poll.json                         poll cursor and per-issue cache
  poll.lock                         single-flight lock held by the poll agent
  runs/<ts>.<KEY>.json              the run record
  spool/<KEY>.<ts>.json             the raw webhook body
  spool/<KEY>.<ts>.prompt.txt       the rendered prompt
  logs/<KEY>.<ts>.log               prepare output and session progress
```

## Single binary

```bash
bun run build        # bun build --compile -> dist/jira-dispatch
```

The binary carries the Bun runtime and the client, so the host needs no
`node_modules` and no Bun. It is per platform: build `darwin-arm64` on the Mac and
`linux-x64` on a Linux host. It still needs the `opencode` CLI on `PATH` unless
`opencode.baseUrl` names a server.

`install` detects how it runs. From the binary it writes a launchd agent that
runs `dist/jira-dispatch serve`; from a source checkout it writes one that runs
`bun run src/cli.ts serve`.

## Test

```bash
bun run test
```

No Jira and no real OpenCode. The check starts the receiver on a free port and a
fake OpenCode server that records every request, then asserts what the receiver
asked for: the session title, the workspace, the prompt text, and the wait. It
also covers the default prompt, the `poll`, `catchup`, `work-mode` and `install`
subcommands. 80 checks.

## Known gaps

- Each hand-off creates a new session. A second hand-off on the same ticket after
  the first session ended starts a second session, rather than continuing the
  first. The lock prevents concurrent sessions; it does not merge runs.
- The catch-up is not automatic. Run `catchup` by hand, or when the receiver
  starts, to pick up tickets that became ready while it was down.
- `poll` adds latency: 60 seconds when work is flowing, up to 15 minutes when
  the receiver has been idle.
- The first watch pass has no cursor, so it scans every ready ticket. Run
  `poll --dry-run` first if a backlog of labeled tickets is not wanted.
- `poll` reacts to a label add only. A fresh assignment with the label already
  present does not start a run; the webhook path is the one that reacts to an
  assignment. Remove and add the label, or run `catchup`, to dispatch it.
- An admin webhook needs a Jira admin. The poll path is the no-admin source.
- There is no anti-replay check on a signed body. The webhook secret is the trust
  boundary, so a replay already requires the secret, which allows forging any
  event.
- `client.session.wait` maps to an experimental API route. If OpenCode changes
  it, the lock hold is the part that breaks.
