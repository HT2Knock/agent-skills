---
name: opencode-afk
description: Continue or start an OpenCode coding session on knockon while the user is away. Use when the user asks to pick up work, continue an OpenCode session, or run a coding task in a repository on knockon. Triggers on: continue the session, pick up where I left off, work on <repo> while I am out, run this in OpenCode, what is in progress.
---

# OpenCode AFK

Drive a durable OpenCode session on `knockon` from a Signal conversation.

## The workflow

The user works in OpenCode. `knockon` is always on and holds the sessions that
survive the user being away. The user's Mac is the interactive workbench; it
sleeps, so never target it for background work.

Use the driver. Do not call `opencode` directly:

```bash
oc-afk <project-dir> <session-title> <prompt...>
```

- `<project-dir>` is an absolute path on knockon, for example `~/JT-notes`.
- `<session-title>` is a stable name. The driver resumes the session with that
  exact title, or creates it on the first run.
- `<prompt...>` is the task.

The driver runs with `--auto`, prints the answer, and reports the session id and
the log path. It uses the model in `OC_MODEL`, default `openai/gpt-6-luna`.

## Long tasks

A task that runs for minutes must not hold the conversation open:

```bash
oc-afk --bg <project-dir> <session-title> <prompt...>
```

That returns a pid and a log path, and sends the answer to Signal when the run
ends. Tell the user it started, then stop. Do not poll the log.

## Rules

- One title is one durable session, not a scratchpad. Reuse the title the user
  names, or pick a short stable one.
- Report the result the user asked for, not the log. Say what changed and which
  files were touched.
- If the answer contains `[error]`, report the error. A `provider` error usually
  means a bad model name; check before retrying.
- Work only in repositories that exist on knockon. List the home directory
  before guessing at a path.
- The knockon clone of the notes repo is `~/JT-notes`. The Mac's clone,
  `~/Documents/T2Knock/JT-notes`, is a different directory on a different host.

## Watching the session

The user can attach to the same session from the Mac:

```bash
oc-knockon ~/JT-notes
```

That opens the OpenCode TUI on knockon in the Mac's terminal. Sessions are
scoped to a directory on the server, so the attach runs on knockon. The Mac's
own TUI cannot show a knockon project.
