import { createHmac, timingSafeEqual } from "node:crypto"

// Account is the shape Jira uses for an issue assignee and for the user who
// made the change.
export type Account = {
  accountId?: string
  emailAddress?: string
  displayName?: string
}

export type ChangelogItem = {
  field?: string
  fromString?: string
  toString?: string
}

// Payload is the part of a Jira webhook body the receiver reads. Jira sends
// more; unknown fields are ignored.
export type Payload = {
  webhookEvent: string
  timestamp?: number
  issue: {
    id?: string
    key: string
    fields?: {
      summary?: string
      labels?: string[]
      assignee?: Account
    }
  }
  user?: Account
  changelog?: { id?: string; items?: ChangelogItem[] }
}

// Decision kinds. The HTTP handler maps each to a status code.
export const Kind = {
  Dispatch: "dispatched",
  Ignore: "ignored",
  Duplicate: "duplicate",
  InFlight: "in-flight",
  // Rejected means the receiver accepted the event and could not act on it.
  // It maps to a 5xx so Jira retries.
  Rejected: "rejected",
} as const

export type Decision = { kind: string; reason: string }

const ignore = (reason: string): Decision => ({ kind: Kind.Ignore, reason })

// verifySignature checks a Jira Cloud webhook signature header. Jira sends
// X-Hub-Signature with the form "sha256=<hex>". The comparison is constant
// time. A bare hex value is also accepted.
export function verifySignature(secret: string, body: Uint8Array, header: string | null | undefined): boolean {
  if (!secret || !header) return false
  const want = createHmac("sha256", secret).update(body).digest()
  for (const rawPart of header.split(",")) {
    let value = rawPart.trim()
    if (!value) continue
    const eq = value.indexOf("=")
    if (eq >= 0) {
      if (value.slice(0, eq).trim().toLowerCase() !== "sha256") continue
      value = value.slice(eq + 1).trim()
    }
    if (value.length !== want.length * 2 || !/^[0-9a-fA-F]+$/.test(value)) continue
    if (timingSafeEqual(Buffer.from(value, "hex"), want)) return true
  }
  return false
}

export function parsePayload(body: string): Payload {
  let parsed: Payload
  try {
    parsed = JSON.parse(body) as Payload
  } catch {
    throw new Error("body is not JSON")
  }
  if (!parsed?.webhookEvent) throw new Error("body has no webhookEvent")
  if (!parsed.issue?.key) throw new Error("body has no issue.key")
  return parsed
}

// projectKey returns the project part of the issue key, for example ADAM.
export function projectKey(p: Payload): string {
  const at = p.issue.key.indexOf("-")
  return at > 0 ? p.issue.key.slice(0, at) : p.issue.key
}

// eventId is the dedupe key. Jira delivers at least once, so the same event can
// arrive more than once.
export function eventId(p: Payload): string {
  if (p.changelog?.id) return p.changelog.id
  const digest = createHmac("sha256", "jira-dispatch")
    .update(JSON.stringify(p.changelog?.items ?? []))
    .digest("hex")
    .slice(0, 16)
  return `${p.webhookEvent}:${p.issue.key}:${p.timestamp ?? 0}:${digest}`
}

export function browseUrl(p: Payload, base: string | undefined): string {
  if (!base) return ""
  return `${base.replace(/\/+$/, "")}/browse/${p.issue.key}`
}

const fold = (list: readonly string[], value: string): boolean => list.some((item) => item.toLowerCase() === value.toLowerCase())

function matchesActor(allowed: readonly string[], user: Account | undefined): boolean {
  if (!user) return false
  return allowed.some((item) => item.toLowerCase() === (user.emailAddress ?? "").toLowerCase() || (!!user.accountId && item === user.accountId))
}

// addsTriggerLabel reports whether this change added one of the labels. Jira
// lists the label field's before and after values as space or comma separated
// text.
export function addsTriggerLabel(p: Payload, want: readonly string[]): boolean {
  for (const item of p.changelog?.items ?? []) {
    if ((item.field ?? "").toLowerCase() !== "labels") continue
    const added = (item.toString ?? "").split(/[\s,]+/).filter(Boolean)
    if (added.some((label) => fold(want, label))) return true
  }
  return false
}

export type FilterInput = {
  workModeOn: boolean
  allowedEvents: readonly string[]
  allowedActors: readonly string[]
  triggerLabels: readonly string[]
  projects: Record<string, unknown>
}

// evaluate applies the read-only filters: work mode, event type, actor, trigger
// label and project mapping. It has no side effects.
export function evaluate(cfg: FilterInput, p: Payload): Decision {
  if (!cfg.workModeOn) return ignore("work mode is off")
  if (!fold(cfg.allowedEvents, p.webhookEvent)) return ignore(`event not in allowedEvents: ${p.webhookEvent}`)
  if (cfg.allowedActors.length > 0 && !matchesActor(cfg.allowedActors, p.user)) {
    return ignore(`actor is not allowed: ${p.user?.emailAddress ?? p.user?.accountId ?? "unknown"}`)
  }
  const labels = p.issue.fields?.labels ?? []
  if (cfg.triggerLabels.length > 0 && !labels.some((label) => fold(cfg.triggerLabels, label))) {
    return ignore("issue has none of the trigger labels")
  }
  // A session comments on its own ticket. Without this rule that comment is an
  // issue_updated event, the label is still present, and the receiver starts a
  // second session on the work the first one just reported. Accept an update
  // only when it added a trigger label.
  if (cfg.triggerLabels.length > 0 && p.webhookEvent === "jira:issue_updated" && !addsTriggerLabel(p, cfg.triggerLabels)) {
    return ignore("this change did not add a trigger label")
  }
  if (!(projectKey(p) in cfg.projects)) return ignore(`no project mapping for ${projectKey(p)}`)
  return { kind: Kind.Dispatch, reason: "accepted" }
}
