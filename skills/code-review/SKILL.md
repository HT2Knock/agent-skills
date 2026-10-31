---
name: code-review
description: "Review a branch, a PR, or the changes since a fixed point on two axes: does the code follow this repo's documented standards, and does it match the spec it came from? Use when the user asks to review a branch, a pull request, or work in progress, or says review since X."
---

# Code review

Review the diff between `HEAD` and a fixed point on two axes, and report them side by side.

- **Standards.** Does the code follow what this repo documents?
- **Spec.** Does it do what the issue or spec asked?

Keep the axes separate. A change can pass one and fail the other: code that follows every rule and implements the wrong thing, or code that does exactly what the ticket asked and breaks the house style. Reporting both stops one axis from hiding the other.

## 1. Pin the fixed point

Use what the user named: a commit, a branch, a tag, `main`. If none is named, ask. Capture `git diff <point>...HEAD` and `git log <point>..HEAD --oneline`, with the three dots so the comparison is against the merge-base. Confirm the ref resolves and the diff is not empty before you go further.

## 2. Find the spec

In this order:

1. Issue references in the commit messages, fetched from the tracker. Use the `atlassian-cli` skill when the tracker is Jira.
2. A path the user passed.
3. A spec file under `docs/`, `specs/`, or `.scratch/`.
4. Ask the user. If there is no spec, the Spec axis reports this and the review continues on Standards only.

## 3. Find the standards

Search the repo for files that say how code is written. `CODING_STANDARDS.md` and `CONTRIBUTING.md` are always on the list when they exist. Add the smell baseline below.

The repo overrides. A documented standard wins over the baseline. Every smell is a labelled heuristic, never a hard violation. Skip anything tooling already enforces.

Each smell reads as what it is, then how to fix it:

- **Mysterious Name.** A function, variable, or type whose name does not reveal what it does. Rename it. If no honest name comes, the design is unclear.
- **Duplicated Code.** The same logic shape appears in more than one hunk or file in the diff. Extract the shared shape.
- **Feature Envy.** A method reaches into another object's data more than its own. Move it onto the data it envies.
- **Data Clumps.** The same few fields or parameters keep travelling together. Bundle them into one type.
- **Primitive Obsession.** A primitive or string stands in for a domain concept that deserves its own type. Give the concept the type.
- **Repeated Switches.** The same switch or if-cascade on the same type recurs. Replace it with polymorphism or one shared map.
- **Shotgun Surgery.** One logical change forces scattered edits across many files in the diff. Gather what changes together into one module.
- **Divergent Change.** One file is edited for several unrelated reasons. Split it so each module changes for one reason.
- **Speculative Generality.** Abstraction or hooks added for needs the spec does not have. Delete it and inline back until a real need shows.
- **Message Chains.** Long `a.b().c().d()` navigation the caller should not depend on. Hide the walk behind one method.
- **Middle Man.** A class or function that mostly delegates. Cut it and call the real target.
- **Refused Bequest.** A subclass that ignores most of what it inherits. Drop the inheritance and use composition.

## 4. Run both axes in parallel

Dispatch two subagents at once, each with a fresh context, and use both reports.

For the Standards axis, give the subagent the diff command, the commit list, the standards files you found, and the smell baseline pasted in full. Ask for every documented breach with the rule it cites, and every smell with the hunk quoted. Ask it to separate hard violations from judgement calls: a documented standard can be hard, a smell never is. Limit the report to 400 words.

For the Spec axis, give the subagent the diff command, the commit list, and the spec. Ask for requirements that are missing or partial, behaviour nobody asked for, and requirements that look implemented but are wrong, each with the spec line quoted. Limit it to 400 words. When there is no spec, skip this subagent and say so.

## 5. Report

Present the two reports under `## Standards` and `## Spec`. Do not merge or rerank them; the separation is the point. End with a count of findings per axis and the worst issue within each axis.
