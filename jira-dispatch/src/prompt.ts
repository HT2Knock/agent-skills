// The prompt sent when a project does not set its own promptTemplate.
// Placeholders: {key} {project} {summary} {url} {workspace}
//
// OpenCode loads the AGENTS.md files and advertises the skills by description,
// so this prompt is the ticket and the two skill names only.
export const defaultPromptTemplate = `Pick up
Ticket {key}: {summary}
{url}
Working directory: {workspace}

Use the atlassian-cli skill for the ticket, and follow the autonomous-run skill.

Decide from the ticket whether it needs an isolated worktree, and say which you chose. Work on your own branch; leave main and merging to the user.
`
