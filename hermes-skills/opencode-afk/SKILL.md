---
name: opencode-afk
description: Continue or start an OpenCode coding session while the user is away, on knockon or on the user's Mac. Use when the user asks to pick up work, continue a session, run a coding task in a repository, or look at work that is not committed yet. Triggers on: continue the session, pick up where I left off, work on <repo> while I am out, run this in OpenCode, what is in progress, uncommitted work.
---

# OpenCode AFK

Drive a durable OpenCode session from a Signal conversation. The driver lives in
this skill directory and is symlinked to `~/.local/bin/oc-afk` on each host:

```bash
oc-afk <project-dir> <session-title> <prompt...>
```

The driver resolves the session by exact title inside the project and creates it
on the first run, so one title is one durable session. It runs with `--auto`,
prints the answer, and reports the session id and the log path.

## Two hosts

- `knockon` is always on. It is the default target and holds the sessions that
  survive the user being away.
- The user's Mac is the interactive workbench. It sleeps. Use it only for work
  that is not committed yet.

Run on the Mac over SSH:

```bash
oc-afk --host macbook <project-dir> <session-title> <prompt...>
```

Quote the path so the target host expands it, not the calling shell:

```bash
oc-afk --host macbook '~/Documents/T2Knock/JT-notes' "jt notes" "..."
```

Each host keeps its own configured model. Set `OC_MODEL` to override it. `--host`
does not support `--bg`.

When the Mac is asleep or closed, that call fails. Say so, then ask the user to
wake the Mac or to push a work-in-progress commit.

## Uncommitted work on the Mac

```bash
ssh macbook 'git -C <dir> status --short'
ssh macbook 'git -C <dir> diff'
```

## Long tasks on knockon

```bash
oc-afk --bg <project-dir> <session-title> <prompt...>
```

That returns a pid and a log path, and posts the answer to Signal when the run
ends. Tell the user it started, then stop. Do not poll the log.

## Rules

- One title is one durable session, not a scratchpad.
- Report the result the user asked for, not the log. Say what changed and which
  files were touched.
- If the answer contains `[error]`, report it. A `provider` error usually means a
  bad model name or an account with no credit.
- Work only in repositories that exist on the target host. List the home
  directory before guessing at a path.
- The notes repo is `~/JT-notes` on knockon and `~/Documents/T2Knock/JT-notes` on
  the Mac.

## Watching a session

`oc-knockon ~/JT-notes` opens the OpenCode TUI on knockon in a Mac terminal. A
session is scoped to a directory that must exist on the server, so the Mac's own
TUI cannot show a knockon project.
