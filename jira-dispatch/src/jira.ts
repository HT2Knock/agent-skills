import { $ } from "bun"
import type { Config } from "./config.ts"

export type Account = {
  accountId?: string
  emailAddress?: string
  displayName?: string
}

export type ChangelogItem = {
  field?: string
  fromString?: string | null
  toString?: string | null
}

export type History = {
  id?: string
  created?: string
  author?: Account | null
  items?: ChangelogItem[]
}

export type Issue = {
  id?: string
  key: string
  fields?: {
    summary?: string
    labels?: string[]
    updated?: string
    assignee?: Account
    issuetype?: unknown
    priority?: unknown
  }
}

type ChangelogPage = {
  startAt?: number
  maxResults?: number
  total?: number
  values?: History[]
}

const pageSize = 100

export function readyJql(cfg: Config): string {
  const labels = cfg.triggerLabels.map((label) => `"${label}"`).join(",")
  const clause = labels ? ` AND labels in (${labels})` : ""
  return `assignee = currentUser()${clause} AND statusCategory != Done ORDER BY updated DESC`
}

export async function search(jql: string, limit: number): Promise<Issue[]> {
  const out =
    await $`atlassian-cli jira issue search --jql ${jql} --limit ${String(limit)} --format json`
      .quiet()
      .text()
  return JSON.parse(out) as Issue[]
}

// Jira returns the changelog oldest first. Read the last page first, then walk
// back until a label add is found, so a long history costs one request.
export async function latestLabelAdd(
  key: string,
  want: readonly string[],
): Promise<History | undefined> {
  if (want.length === 0) return undefined
  const first = await changelogPage(key, 0)
  const total = first.total ?? first.values?.length ?? 0
  let startAt = Math.max(0, total - pageSize)
  let page = startAt === 0 ? first : await changelogPage(key, startAt)

  for (;;) {
    const values = page.values ?? []
    for (let i = values.length - 1; i >= 0; i--) {
      if (addsLabel(values[i], want)) return values[i]
    }
    if (startAt === 0) return undefined
    startAt = Math.max(0, startAt - pageSize)
    page = await changelogPage(key, startAt)
  }
}

// A label add is a label in toString that was not in fromString. The webhook
// path can only inspect toString; this is stricter.
function addsLabel(history: History, want: readonly string[]): boolean {
  for (const item of history.items ?? []) {
    if ((item.field ?? "").toLowerCase() !== "labels") continue
    const before = new Set(splitLabels(item.fromString))
    const added = splitLabels(item.toString).filter((label) => !before.has(label))
    if (added.some((label) => want.some((wanted) => wanted.toLowerCase() === label))) return true
  }
  return false
}

function splitLabels(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((label) => label.toLowerCase())
}

async function changelogPage(key: string, startAt: number): Promise<ChangelogPage> {
  const path = `/rest/api/3/issue/${key}/changelog`
  const out =
    await $`atlassian-cli jira api ${path} --query ${`startAt=${startAt}`} --query ${`maxResults=${pageSize}`} --format json`
      .quiet()
      .text()
  return JSON.parse(out) as ChangelogPage
}
