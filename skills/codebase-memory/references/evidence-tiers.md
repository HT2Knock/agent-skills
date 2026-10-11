# Evidence tiers

Choose one tier before you gather evidence. State the tier in the answer when
the claim matters.

## Scout

Use for a quick positive lookup.

- A few targeted calls and a source check of the result.
- Label the answer provisional.
- Do not claim that something is absent, unused, or dead.
- Do not claim that a search was exhaustive.
- Do not claim complete impact.

## Verify (default)

Use for a normal task in a connected project.

- Graph evidence directed at the task.
- Both call directions when they are material: callers and callees.
- Exact snippets for every material claim.
- Follow the pagination that is relevant to the claim.
- Call `check_index_coverage` for every evidence path.

## Auditor

Use for a bounded, high-stakes claim: a release, a security review, or an
impact statement.

- State the current project generation.
- Follow all relevant pagination and both call directions.
- Cover broader relationships when the claim depends on them.
- Disclose every limitation, including stale or unknown coverage.
- Do not extend the scope beyond the bounded area you named.

## Coverage rules

`check_index_coverage` reports index state, not truth.

| Result | Action |
| --- | --- |
| Clean | Treat as no recorded gap. It is not proof of completeness. |
| Partial, skipped, excluded, pending, or unknown | Read or grep the reported ranges. |
| Stale | Refresh the index, or disclose the staleness before you rely on it. |
