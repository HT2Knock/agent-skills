---
name: wip-handoff
description: Move in-progress Mac work to knockon and start an autonomous OpenCode session there, before the Mac sleeps. Use when the user says to move the wip to knockon, hand it off, or continue work on the other machine, for a personal project with no remote, or to run the flow in reverse.
---

# WIP handoff

knockon is always on; the Mac is not. When work must outlive the Mac going to
sleep, snapshot the dirty tree into git, move the snapshot to the knockon clone,
and launch a detached OpenCode run there. The Mac session drives every step over
ssh. Only the change travels; each side keeps its own repo.

Name the handoff with a topic: the repo name plus a short slug, for example
`homelab-dashboards`. Reuse the same topic to re-push updated work.

## Push the snapshot (Mac)

```bash
~/.agents/skills/wip-handoff/scripts/push-wip.sh --repo <path> <topic>
```

The script turns the working tree, tracked and untracked, into one commit and
pushes it to `wip/<topic>`. Ignored files stay out. The Mac tree and index are
unchanged. Done when it prints `pushed wip/<topic> to <target>`.

`--dry-run` records nothing and pushes nothing, so it never blocks a later push.

No remote, a private repo, or work that stays on the tailnet: push straight to
knockon with `--target knockon:<path>`. Prefer that for personal work; it is
faster and it stays off shared remotes.

## Pick up and launch (knockon, driven over ssh)

Every step runs from the Mac, over `ssh knockon`.

1. Ensure the clone exists. Work repos live in
   `~/workspace/github.com/AIRR-Labs/<repo>`, personal repos in
   `~/workspace/github.com/<owner>/<repo>`.

```bash
ssh knockon 'test -d ~/workspace/github.com/<owner>/<repo> || \
  git clone git@github.com:<owner>/<repo>.git ~/workspace/github.com/<owner>/<repo>'
```

2. Create the worktree from the snapshot. The push above put it at
   `refs/heads/wip/<topic>`. If the snapshot went to `origin` instead, run
   `git fetch origin` first and base the worktree on `origin/wip/<topic>`.

```bash
ssh knockon 'git -C ~/workspace/github.com/<owner>/<repo> \
  worktree add -b continue/<topic> /tmp/wip-<topic> refs/heads/wip/<topic>'
```

Done when `ssh knockon 'git -C /tmp/wip-<topic> status --short'` prints nothing.

3. Write one handoff document, `HANDOFF.md`, into `$TMPDIR` on the Mac. It is
   the knockon run's only context: what is done, verified facts with exact
   values, what remains, and which skills to load. One document, not two.

4. Copy it into the worktree and launch a detached run. Detached means it
   survives the Mac sleeping and the ssh session ending:

```bash
scp -q "$TMPDIR/HANDOFF.md" knockon:/tmp/wip-<topic>/HANDOFF.md
ssh knockon 'cd /tmp/wip-<topic> && \
  nohup setsid opencode run --auto --title "<topic>" "$(cat HANDOFF.md)" \
  </dev/null > /tmp/wip-<topic>.log 2>&1 & sleep 5; pgrep -f "opencode run --auto"'
```

`--auto` approves permissions, which headless runs need. Done when a pid
prints; a minute later `ssh knockon 'wc -c /tmp/wip-<topic>.log'` shows the log
growing.

The knockon run works, commits to `continue/<topic>`, and pushes. Merge that
branch in a later session.

## Clean up

```bash
ssh knockon 'git -C ~/workspace/github.com/<owner>/<repo> worktree remove /tmp/wip-<topic>'
git -C <path> push origin --delete wip/<topic>       # pushed to a remote
git -C <path> update-ref -d refs/heads/wip/<topic>   # pushed straight to a host
```

Done when `ssh knockon 'git -C ~/workspace/github.com/<owner>/<repo> worktree list'`
shows only the main worktree.

## Reference

The rationale, the one rsync case, the performance numbers, and the failure
modes are in [reference.md](reference.md).
