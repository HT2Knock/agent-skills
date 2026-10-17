---
name: wip-handoff
description: Hand off uncommitted work between the Mac and knockon as a git snapshot. Use when work must continue on the other machine: dirty Mac work to pick up on knockon, a personal project with no remote, or a change to verify on the Mac.
---

# WIP handoff

knockon is always on. The Mac holds uncommitted work. Move a **snapshot** of that
work to the clone on the other machine. The transport is git, so only the change
travels and each side keeps its own repo.

## Push from the Mac

```bash
~/.agents/skills/wip-handoff/scripts/push-wip.sh --repo <path> <topic>
```

The script turns the working tree, tracked and untracked, into one commit and pushes
it to `wip/<topic>`. Ignored files stay out. The Mac working tree and index are
unchanged.

Push to `origin` by default. For a private repo, a repo with no remote, or work that
stays on the tailnet, push straight to knockon instead:

```bash
~/.agents/skills/wip-handoff/scripts/push-wip.sh \
  --repo ~/path/to/repo \
  --target knockon:/home/t2knock/workspace/github.com/<owner>/<repo> \
  <topic>
```

Done when the script prints `pushed wip/<topic>`. `--dry-run` stops before the push.
The script refuses secret-like paths and new files over 50 MiB; override with
`--allow-secret` and `--allow-large`.

## Pick up on knockon

Use the clone that already exists. Work repos are in
`~/workspace/github.com/AIRR-Labs/<repo>`; personal repos in
`~/workspace/github.com/<owner>/<repo>`.

When the Mac pushed straight to knockon, the ref is local:

```bash
git -C <repo> worktree add -b continue/<topic> /tmp/wip-<topic> refs/heads/wip/<topic>
```

When the Mac pushed to `origin`:

```bash
git -C <repo> fetch origin
git -C <repo> worktree add -b continue/<topic> /tmp/wip-<topic> origin/wip/<topic>
```

Done when the worktree exists and `git -C /tmp/wip-<topic> status` is clean. Work
there, then commit and push `continue/<topic>`. The skill runs in reverse too:
knockon pushes to the Mac with `--target macbook:<path>`.

## Clean up

```bash
git -C <repo> worktree remove /tmp/wip-<topic>
git -C <repo> push origin --delete wip/<topic>       # pushed to a remote
git -C <repo> update-ref -d refs/heads/wip/<topic>   # pushed straight to a host
```

Done when `git -C <repo> worktree list` shows only the main worktree.

## Reference

The rationale, the one rsync case, the performance numbers, and the failure modes
are in [reference.md](reference.md).
