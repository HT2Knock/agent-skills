---
name: wip-handoff
description: Move uncommitted work between the Mac and knockon without copying repos. Use when the Mac holds dirty work that knockon must continue, when a personal project must be picked up on knockon, or when a change must go back for verification. Snapshots the working tree to wip/<topic> with git.
---

# WIP handoff

knockon is always on. The Mac holds uncommitted work. This skill moves a snapshot
of that work to a clone on the other machine. It never copies a repository.

## Why git, not rsync

`git` snapshots the change. rsync copies state: it overwrites the other checkout,
has no conflict signal, and copies ignored files such as `.env` and `node_modules`.

Use rsync only for one gitignored file that a test needs, and name that path
exactly. Never run `rsync -a repo/`.

## Push from the Mac

```bash
~/.agents/skills/wip-handoff/scripts/push-wip.sh --repo <path> <topic>
```

The script snapshots the working tree, including untracked files that git does not
ignore, into `wip/<topic>`. The Mac working tree and index do not change. The
snapshot starts from the current `HEAD`, so the receiver sees a normal diff.

- The default push goes to `origin`.
- For a private repo, a repo with no remote, or work that must not leave the
  tailnet, push straight to knockon:

```bash
~/.agents/skills/wip-handoff/scripts/push-wip.sh \
  --repo ~/path/to/repo \
  --target knockon:/home/t2knock/workspace/github.com/<owner>/<repo> \
  <topic>
```

- `--dry-run` makes the snapshot and stops.
- The script refuses paths that look like secrets (`.env`, `*.pem`, `id_*`) and new
  files over 50 MiB. Inspect, then override with `--allow-secret` or `--allow-large`.

## Pick up on knockon

The clone already exists on knockon. Do not clone it again. Work repos live in
`~/workspace/github.com/AIRR-Labs/<repo>`. Personal repos live in
`~/workspace/github.com/<owner>/<repo>`.

When the Mac pushed straight to knockon, the ref is already local:

```bash
git -C <repo> worktree add -b continue/<topic> /tmp/wip-<topic> refs/heads/wip/<topic>
```

When the Mac pushed to `origin`:

```bash
git -C <repo> fetch origin
git -C <repo> worktree add -b continue/<topic> /tmp/wip-<topic> origin/wip/<topic>
```

Work in the worktree. Commit and push `continue/<topic>` when the work is ready.
The same skill runs in reverse: knockon can push to the Mac with
`--target macbook:<path>`.

## Clean up

```bash
git -C <repo> worktree remove /tmp/wip-<topic>
git -C <repo> push origin --delete wip/<topic>       # pushed to a remote
git -C <repo> update-ref -d refs/heads/wip/<topic>   # pushed straight to a host
```

## The one rsync case

A gitignored file that the test needs, for example a non-prod `.env`:

```bash
rsync -a --relative ./path/to/file knockon:/path/to/repo/
```

Name the path. Do not copy the repository.

## Performance

The working-tree scan is the cost. The script copies the real index into a
temporary index, so the scan reuses the stat data, the untracked cache, and the
fsmonitor extension. On `pim` this cuts the scan from about 110 ms to 15 ms.

Measured on `infrastructure` (253 files, 12 changed): snapshot about 90 ms, push to
knockon over Tailscale about 0.7 s, push to GitHub about 3 s. Prefer the direct push
to knockon for personal work.

For a large repository, enable the index caches once:

```bash
git config --global feature.manyFiles true
git config --global core.fsmonitor true
```

## Failure modes

- Non-fast-forward: the script forces `wip/<topic>` on purpose. The namespace is
  scratch only.
- The remote rejects the push: check the remote name, or pass `--target`.
- The repo is missing on knockon: clone it first, then hand off again.
