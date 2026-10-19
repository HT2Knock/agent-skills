import { createHmac } from "node:crypto"
import { $ } from "bun"
import { loadConfig, type Config } from "./config.ts"
import { readSecret } from "./secret.ts"
import { firstOf, or } from "./values.ts"

type Issue = {
  id?: string
  key: string
  fields?: {
    summary?: string
    labels?: string[]
    assignee?: unknown
    issuetype?: unknown
    priority?: unknown
    updated?: string
  }
}

export async function catchupCommand(
  configPath: string,
  options: Record<string, string>,
  args: string[],
): Promise<void> {
  const cfg = loadConfig(configPath)
  const secret = readSecret(cfg.secretEnv)
  const url = firstOf(`http://${cfg.listen}/jira/hook`, options.url, Bun.env.JIRA_DISPATCH_URL)
  const limit = Number(firstOf("50", options.limit, Bun.env.JIRA_DISPATCH_CATCHUP_LIMIT))
  const jql = firstOf(buildJql(cfg), options.jql, args[0])

  console.log(`query: ${jql}`)
  console.log(`post:  ${url}\n`)

  const actor = or(cfg.allowedActors[0], "unknown@example.com")
  for (const issue of await search(jql, limit)) {
    const payload = JSON.stringify(toPayload(issue, actor))
    const response = await post(url, secret, payload)
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

function buildJql(cfg: Config): string {
  const labels = cfg.triggerLabels.map((label) => `"${label}"`).join(",")
  const clause = labels ? ` AND labels in (${labels})` : ""
  return `assignee = currentUser()${clause} AND statusCategory != Done ORDER BY updated DESC`
}

async function search(jql: string, limit: number): Promise<Issue[]> {
  const out =
    await $`atlassian-cli jira issue search --jql ${jql} --limit ${String(limit)} --format json`
      .quiet()
      .text()
  return JSON.parse(out) as Issue[]
}

async function post(url: string, secret: string, body: string): Promise<Response> {
  const signature = createHmac("sha256", secret).update(body).digest("hex")
  return fetch(url, {
    method: "POST",
    headers: { "x-hub-signature": `sha256=${signature}`, "content-type": "application/json" },
    body,
  })
}

async function kindOf(response: Response): Promise<string> {
  try {
    return ((await response.json()) as { kind?: string }).kind ?? "?"
  } catch {
    return "?"
  }
}
