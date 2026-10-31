---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Word each question so "yes" accepts your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

## When the answer is not the user's

When a frontier question belongs to someone the user has to ask, do not put it to the user. Write a questionnaire for that person, save it as `to-questionnaire-<slug>.md` in the current directory, and report the path.

Grill the send, not the subject. Ask the user only who receives it, what that person knows that the user does not, and what the user must be able to decide when it comes back. Aim the questions at that gap, most important first, because one async pass may be all you get. One question is one idea, and every question has an answer stub under it.

```markdown
# <Title>

**Purpose:** the decision riding on this. **From:** <user> **To:** <recipient>

## Context

One paragraph for a recipient who was not in the conversation.

## How to answer

Deadline, rough effort, and that "I don't know" is a useful answer.

## <Theme>

### <One question, one idea>

> <answer stub>

## Anything else?
```
