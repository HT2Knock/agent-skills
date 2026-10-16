---
name: herdr
description: "Control Herdr, a terminal multiplexer for coding agents. Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HERDR_ENV=1."
---

# Herdr

Herdr organizes terminals into workspaces, tabs, and panes, recognizes coding agents inside panes, and exposes the current session through the `herdr` CLI.

## Gate first

Confirm that this agent runs inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, say that you are not running inside Herdr and stop. Do not inspect or control the session from outside.

## Read the command syntax from the binary

The installed binary defines the flags, and they change between versions. Read it instead of guessing:

```bash
herdr --help
herdr agent        # print a command group
herdr pane
herdr workspace
```

Run a group with no subcommand to list its commands. Always pass a subcommand or `--help`, because bare `herdr` launches the TUI. Give every argument to a mutating command: one such as `herdr workspace create` accepts defaults and executes. Most control commands return JSON; read IDs and state from the response.

## Pick the primitive

- Workspace, tab, and pane commands control terminal locations and raw terminals.
- Agent commands control the recognized coding agent in a pane and interpret its lifecycle.

A pane exists with or without an agent. `agent start` needs an existing shell pane and never creates, splits, or moves layout. Use pane commands for ordinary processes, and agent commands when Herdr must validate agent identity or interpret lifecycle states.

Agent commands take a unique live agent name or its pane ID, not a terminal ID or a bare kind label. Names match `[a-z][a-z0-9_-]{0,31}` and follow the current pane occupant.

## Lifecycle states

- `idle` and `done`: ready for input. The CLI and each TUI client track "seen" separately, so their badges can differ.
- `blocked`: Herdr recognized an approval or question UI. Inspect it and ask the user before answering.
- `unknown`: an agent is present but not classified. It does not mean done.

## IDs and caller context

IDs are opaque handles: workspace `w1`, tab `w1:t1`, pane `w1:p1`. Closed IDs are not reused. A pane moved to another workspace gets a new qualified ID; read it from `.result.move_result.pane.pane_id`.

Herdr injects the caller context into each managed pane:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` when a command should target the calling pane. Other commands may use the UI-focused pane, which can belong to the user or another client. Discover live state with `workspace list`, `tab list --workspace "$HERDR_WORKSPACE_ID"`, `pane list`, and `agent list`. Creation responses expose the IDs to use next.

IDs and names are scoped to one server. Use `--machine <label-or-id>` with an enabled saved profile, never an arbitrary SSH hostname. Discover IDs on that machine; local IDs and `--current` do not resolve remotely, and `--machine` cannot combine with `--session` or `--remote`. Both installations need machine API forwarding and a running, compatible server. A connection failure does not prove that a mutation did not apply, so inspect remote state before retrying. `machine reconnect` and interactive `machine add` need the user.

## Start and coordinate an agent

Default to a sibling pane in the current tab and the current working directory. Honor a direction the user gave. Otherwise split a wide pane to the right and a narrow or tall pane down, and keep the user's focus:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Read the new pane ID from `.result.pane.pane_id`. The pane's shell must sit at an interactive prompt, with no foreground command, editor, or agent.

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id>
herdr agent prompt reviewer "Review the current diff." --wait --timeout 120000
herdr agent wait reviewer --until blocked --timeout 120000
herdr agent send-keys reviewer esc
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
```

`agent start` returns after Herdr detects the expected agent and calls it ready for input. `agent prompt --wait` honors the pane's paste mode, sends the text and Enter as one submission, and waits for the first settled `idle`, `done`, or `blocked` state. It returns `agent_prompt_stalled` when no activity follows, or `timeout` when the caller timeout expires first. A timeout or stall does not prove that the prompt was not delivered, so inspect `agent get` and `agent read` before resending. Use `--until` only for a state-specific wait.

Read sources: `visible` (viewport), `recent` (recent output with soft wraps), `recent-unwrapped` (prefer for logs and transcripts), `detection` (the plain-text snapshot used for detection). Use `--format ansi` only when styling is the evidence. Prefer the agent surface over raw pane input unless raw terminal control is intentional.

## Run an ordinary command in another pane

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr pane run <returned-pane-id> "just test"
herdr pane wait-output <returned-pane-id> --match "test result" --timeout 120000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

`pane run` sends the command text and Enter atomically. `pane wait-output` searches the current snapshot immediately, so output that already exists can match. Use `--match` for a literal substring or `--regex` for a pattern. Omit the timeout to wait until output appears.

## Safety

- Use `--no-focus` for background work unless the user asked to switch context.
- Target with `--current`, an explicit ID, or a unique agent name, and not with another client's focused pane.
- Parse IDs from the JSON responses, not from sidebar order.
- Do not close workspaces, tabs, panes, or sessions you did not create. `workspace close --group` also closes linked worktree workspaces.
- Use `--trust-repository` only after the user verified the repository. It is not a retry for a failed worktree command.
- Check `herdr status` before relying on a new server feature. A missing method is not permission to upgrade or stop the server.
- Never run `herdr server stop`, and never kill the main Herdr process, unless the user asks. Use a named test session for experiments.
- CLI server errors are JSON on stderr with exit status 1. CLI syntax errors exit with status 2.
