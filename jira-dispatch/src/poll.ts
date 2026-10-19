import { loadConfig, type Config } from "./config.ts"
import { latestLabelAdd, readyJql, search, type History, type Issue } from "./jira.ts"
import { kindOf, postHook } from "./receiver.ts"
import { readSecret } from "./secret.ts"
import { firstOf } from "./values.ts"

// Reads the issue changelog, so a comment or a summary edit on a ticket that
// already carries the label is not a new trigger. The webhook path is not open
// to a normal Jira user, so this is the source for a personal workflow.
export async function pollCommand(
  configPath: string,
  options: Record<string, string>,
  args: string[],
): Promise<void> {
  const cfg = loadConfig(configPath)
  if (cfg.triggerLabels.length === 0) {
    throw new Error("poll needs at least one trigger label; set triggerLabels in the config")
  }

  const secret = readSecret(cfg.secretEnv)
  const url = firstOf(`http://${cfg.listen}/jira/hook`, options.url, Bun.env.JIRA_DISPATCH_URL)
  const limit = Number(firstOf("50", options.limit, Bun.env.JIRA_DISPATCH_CATCHUP_LIMIT))
  const jql = firstOf(readyJql(cfg), options.jql, args[0])
  const interval = Number(firstOf("0", options.interval, Bun.env.JIRA_DISPATCH_POLL_INTERVAL))
  const dryRun = options["dry-run"] === "true"

  let repeat = true
  while (repeat) {
    await pass(cfg, secret, url, jql, limit, dryRun)
    repeat = interval > 0
    if (repeat) await Bun.sleep(interval * 1000)
  }
}

async function pass(
  cfg: Config,
  secret: string,
  url: string,
  jql: string,
  limit: number,
  dryRun: boolean,
): Promise<void> {
  const issues = await search(jql, limit)
  if (issues.length === 0) {
    console.log("no ready tickets")
    return
  }

  for (const issue of issues) {
    const history = await latestLabelAdd(issue.key, cfg.triggerLabels)
    if (!history?.id) {
      console.log(`${issue.key.padEnd(12)} skipped: no label-add history`)
      continue
    }

    const body = JSON.stringify(toPayload(issue, history, cfg))
    if (dryRun) {
      console.log(`${issue.key.padEnd(12)} would post ${history.id}`)
      continue
    }

    const response = await postHook(url, secret, body)
    console.log(`${issue.key.padEnd(12)} ${response.status} ${await kindOf(response)}`)
  }
}

// The payload matches a Jira webhook for the same change, including the
// changelog id. The receiver therefore dedupes a poll and a webhook delivery
// of the same event.
function toPayload(issue: Issue, history: History, cfg: Config): unknown {
  return {
    webhookEvent: "jira:issue_updated",
    timestamp: Date.parse(history.created ?? "") || 0,
    issue: {
      id: issue.id ?? "",
      key: issue.key,
      fields: {
        summary: issue.fields?.summary ?? "",
        labels: issue.fields?.labels ?? [],
      },
    },
    user: history.author ?? { emailAddress: cfg.allowedActors[0] },
    changelog: {
      id: history.id,
      items: (history.items ?? []).filter((item) => (item.field ?? "").toLowerCase() === "labels"),
    },
  }
}
