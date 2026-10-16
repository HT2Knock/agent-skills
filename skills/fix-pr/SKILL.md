---
name: fix-pr
description: "Fix an active pull request: failing CI checks, merge conflicts, and review comments. Use when CI is red, a branch has conflict markers, or review feedback needs an action list."
---

# Fix PR

Work on the active pull request through `gh`, resolved from the current branch or from a URL the user gave. Each branch below ends when its check passes.

## Failing CI

1. Inspect the check set: `gh pr checks --json name,bucket,state,workflow,link`.
2. Open the first failed job and read the first actionable error. Use the Actions log when it is available; otherwise follow the check link to the failing command or service.
3. Apply the smallest safe fix.
4. Push and re-check the set.

Done when every check is green.

## Merge conflicts

1. List the conflicting files from `git status` and the conflict markers.
2. Resolve each conflict with the smallest correctness-first edit. Preserve both sides when that is safe; otherwise keep the variant that compiles and holds public behavior stable.
3. Regenerate lockfiles with the package manager, never by hand.
4. Run compile, lint, and the relevant tests.

Done when no conflict markers remain and the build and tests pass.

## Review comments

1. Fetch the review comments and the discussion comments.
2. Group the feedback by severity and actionability.
3. Write a concise action list, ordered by priority, plus the open questions that still need an answer.

Done when every comment is either in the action list or marked resolved.

## Guardrails

- Fix one actionable failure at a time.
- Keep the changes minimal; repair, do not refactor.
- Do not push or tag during conflict resolution.
- `gh pr checks` is the source of truth for the CI state.

## Output

- The primary failing job or conflict, and its root error
- The fixes applied, in order
- The current CI status and the next action
