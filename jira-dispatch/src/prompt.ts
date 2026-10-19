// The prompt sent when a project does not set its own promptTemplate.
// Placeholders: {key} {project} {summary} {url} {workspace}
//
// OpenCode loads the AGENTS.md files and advertises the skills by description,
// so this prompt names the skills and sets the finish condition only.
export const defaultPromptTemplate = `Unattended run. The user is away.

Ticket {key}: {summary}
{url}
Working directory: {workspace}

Use the atlassian-cli skill for the ticket, and follow the autonomous-run skill.

Finish condition: one comment on {key} with what you did, what you decided, and what is blocked.
- Verifiable change: the comment carries a draft PR link.
- Decision no test can settle: the comment carries the options and a recommendation, and there is no PR.

Decide from the ticket whether it needs an isolated worktree, and say which you chose. Work on your own branch; leave main and merging to the user.
`
