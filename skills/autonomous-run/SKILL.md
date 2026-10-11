---
name: autonomous-run
description: "Drive one long task to a checkable finish condition with no human in the loop. Use when the user sleeps, drives, or is away and wants the work finished by the morning, and for any request that says 'run until done', 'keep going', or 'work on this overnight'. Not for a queue of independent changes — use a kanban board for that."
---

# Autonomous run

Drive one task to a finish condition, unattended.

## Before the first iteration

Settle four things, in writing, in the task repository. Do not start without them.

1. **Finish condition.** One check that passes or fails: a test command, a predicate over the tree, a required diff of zero. "Work for four hours" is a duration, not a finish condition.
2. **Isolation.** A fresh `git worktree`, so the run cannot collide with open work.
3. **Decision log.** A TSV at the run root, one row per iteration: time, phase, decision, reason, evidence, result. See the `show-me-your-work` skill.
4. **Stop conditions.** The iteration cap and the wall-clock cap. At a cap, stop and write what blocked the run.

## Each iteration

1. Check the finish condition.
2. Make the smallest change the evidence justifies.
3. Verify against the finish condition, on the real artifact.
4. Commit the change when the check improved. Discard it when the check did not move.
5. Write one row to the decision log.

A plateau means change the approach, not stop. Never weaken the finish condition to declare victory.

## When to stop

Stop when the finish condition passes. Also stop, and write up the reason, when the run hits a real dead end, when the next step is irreversible, or when the decision is a product or preference call that no experiment can settle.

## Report

Send one message: the finish condition, the iterations run, what landed, what was discarded, and the final state of the check. On Signal, keep it short. The detail lives in the decision log and the branch.

## Wake mechanism

The run needs a start and a heartbeat. On `knockon`, Hermes cron supplies both. For a code task, the executor is an OpenCode session driven by `oc-afk`, with the worktree as its workspace. For many independent units, use a kanban board in place of one run.

## Attribution

Borrowed from the `autonomous-run` playbook of `poteto-mode` in pstack by Lauren Tan, through the `pstack-claude` port by Michael Denyer (MIT). The upstream text is kept verbatim in `references/poteto-autonomous-run.md`.
