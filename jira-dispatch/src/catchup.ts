import { loadConfig } from "./config.ts"
import { readyJql, search, type Issue } from "./jira.ts"
import { kindOf, postHook } from "./receiver.ts"
import { readSecret } from "./secret.ts"
import { firstOf, or } from "./values.ts"

export async function catchupCommand(
  configPath: string,
  options: Record<string, string>,
  args: string[],
): Promise<void> {
  const cfg = loadConfig(configPath)
  const secret = readSecret(cfg.secretEnv)
  const url = firstOf(`http://${cfg.listen}/jira/hook`, options.url, Bun.env.JIRA_DISPATCH_URL)
  const limit = Number(firstOf("50", options.limit, Bun.env.JIRA_DISPATCH_CATCHUP_LIMIT))
  const jql = firstOf(readyJql(cfg), options.jql, args[0])

  console.log(`query: ${jql}`)
  console.log(`post:  ${url}\n`)

  const actor = or(cfg.allowedActors[0], "unknown@example.com")
  for (const issue of await search(jql, limit)) {
    const payload = JSON.stringify(toPayload(issue, actor))
    const response = await postHook(url, secret, payload)
    console.log(`${issue.key.padEnd(12)} ${response.status} ${await kindOf(response)}`)
  }

  console.log("\ndone")
}

// The changelog id is derived from the ticket and its updated time, so a second
// catch-up on the same revision is a no-op.
function toPayload(issue: Issue, actor: string): unknown {
  return {
    webhookEvent: "jira:issue_assigned",
    timestamp: 0,
    issue: issuePayload(issue),
    user: { emailAddress: actor },
    changelog: { id: `catchup:${issue.key}:${or(issue.fields?.updated, "")}` },
  }
}

function issuePayload(issue: Issue): unknown {
  const fields = issue.fields ?? {}
  return {
    id: or(issue.id, ""),
    key: issue.key,
    fields: {
      summary: or(fields.summary, ""),
      labels: or(fields.labels, []),
      assignee: or(fields.assignee, {}),
      issuetype: or(fields.issuetype, {}),
      priority: or(fields.priority, {}),
    },
  }
}
