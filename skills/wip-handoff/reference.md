# WIP handoff reference

## Why git, not rsync

`git` snapshots the change. rsync copies state: it replaces the other checkout,
gives no conflict signal, and carries ignored files such as `.env` and
`node_modules`. Reach for rsync only when a test needs one gitignored file, and name
that file:

```bash
rsync -a --relative ./path/to/file knockon:/path/to/repo/
```

## What the script does

1. Copies the real `.git/index` to a temporary index.
2. Runs `git add -A` into the temporary index.
3. Runs `git write-tree` and `git commit-tree`, with `HEAD` as the parent.
4. Checks the snapshot for secret-like paths and new files over 50 MiB.
5. Forces the commit to `refs/heads/wip/<topic>` on the target, then records
   `refs/wip/<topic>` locally. The record marks what was pushed, so a repeat
   run reports `no changes since wip/<topic> was last pushed` instead of pushing
   again. `--dry-run` records nothing, so it never blocks the real push.

## Performance

The working-tree scan is the cost. The copied index carries the stat data, the
untracked cache, and the fsmonitor extension, so the scan reuses them.

| Repo | files | `git status` | fresh index | copied index |
| --- | --- | --- | --- | --- |
| pim | 3157 | 13 ms | 107 ms | 15 ms |
| pim-ui | 1274 | 9 ms | 47 ms | 13 ms |
| infrastructure | 253 | 6 ms | 18 ms | 10 ms |

Full flow on `infrastructure`: snapshot about 90 ms, push to knockon about 0.7 s,
push to GitHub about 3.2 s. Prefer the direct push to knockon for personal work:
it is faster and it stays private.

For a large repository, enable the index caches once:

```bash
git config --global feature.manyFiles true
git config --global core.fsmonitor true
```

## The detached launch

`nohup setsid` separates the run from the ssh session, so ending the session or
letting the Mac sleep does not kill it. `--auto` approves permissions, which
headless runs need. The log at `/tmp/wip-<topic>.log` is the progress check:
`ssh knockon 'wc -c /tmp/wip-<topic>.log'` should grow.

## Failure modes

- Nothing to push: the script says which (`no changes since wip/<topic> was last
  pushed`, `working tree matches HEAD`, or `no tracked or untracked files`).
  Commit the work or change the topic.
- Non-fast-forward: the script forces `wip/<topic>` on purpose. The namespace is
  scratch.
- Push rejected: check the remote name, or pass `--target`.
- No clone on knockon: the pickup step clones it before the worktree.
