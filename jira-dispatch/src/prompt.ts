// The prompt sent when a project does not set its own promptTemplate.
// Placeholders: {key} {project} {summary} {url} {workspace}
export const defaultPromptTemplate = `Unattended run; the user is away and cannot answer.

Ticket {key}: {summary}
{url}
Working directory: {workspace}

Read the repository AGENTS.md files before you change anything, and follow them. Read the ticket and its comments with the atlassian-cli skill.

Decide from the ticket whether it needs an isolated worktree. If it does, create one with git worktree add and work inside it. Say which you chose.

Follow the autonomous-run skill: settle one finish condition, keep a decision log, and stop at the caps.

Choose the mode from the ticket, not from a guess about size:
- Verifiable change: implement it, push a branch, open a draft PR, and comment the PR link on {key}.
- Decision that no test can settle: comment the options and a recommendation on {key}, and stop. Open no PR.

Finish with one comment on {key}: what you did, what you decided, and what is blocked. Work on your own branch, and leave main and merging to the user.
`
