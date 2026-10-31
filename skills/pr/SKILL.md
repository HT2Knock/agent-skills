---
name: pr
description: "Write or improve a pull request body, and make the change easy to review. Use when opening a pull request, updating a PR description, or when asked to make a PR easy to review."
---

# Pull request

A reviewer reads the body before the diff. Give them the smallest view that explains the change, the evidence that it works, and what happens if it is merged and wrong.

## The body

```markdown
## Summary

<one short paragraph, then the smallest view that shows the change>

## Evidence

- **Before:** <failing test output, screenshot, or measured value>
- **After:** <passing run, screenshot, or measured value>

## Impact

**Reversible:** <yes or no>

<what breaks if this is wrong, and who notices>
```

Keep the prose short and skip preambles.

### Summary

Pick one view that carries the point:

- logic as pseudocode;
- control flow as a call tree;
- UI structure as a component tree;
- file responsibility as a shallow tree;
- component or data flow as a Mermaid diagram;
- a diff, when the shape already exists and only the change matters.

Show only what answers the reviewer's next question. One view is usually enough.

### Evidence

Show a before and an after. A screenshot is strongest for a visual change. A test run is strongest for behaviour: paste the failing run and the passing run.

### Impact

Say whether the change can be undone. A change that cannot be rolled back, or that destroys data, needs the reason and the rollback plan in the body.

Name what breaks if the change is wrong: consumers, layout, data, performance. Leave out vague risk words.

## Making an existing PR easy to review

1. Read the diff, the commit list, and the current body.
2. Find the problems: noisy commits, a stale description, unrelated changes, mechanical edits mixed with logic, missing evidence.
3. Propose the cleanup before you rewrite history or force-push.
4. Improve the body first. Most review problems are description problems, not code problems.
5. Rewrite history only when the user agrees. Verify the tree is unchanged after:

   ```bash
   ORIGINAL_TREE=$(git rev-parse origin/<branch>^{tree})
   # rewrite, then
   echo "$ORIGINAL_TREE"; git rev-parse HEAD^{tree}
   ```

Separate core files from generated or mechanical files. Call out migration order, rollout, and test coverage. Link the issue, design doc, or dashboard that explains intent.

## Guardrails

- Never hide a behaviour change inside cleanup.
- Do not bypass hooks.
- If the PR is too large for notes to fix, recommend splitting it.
