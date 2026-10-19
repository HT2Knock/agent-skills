import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadConfig, type Config } from "./config.ts"
import { latestLabelAdd, readyJql, search, type History, type Issue } from "./jira.ts"
import { kindOf, postHook } from "./receiver.ts"
import { readSecret } from "./secret.ts"
import { firstOf } from "./values.ts"

type CachedIssue = {
  // The issue's updated value from the last successful scan.
  updated?: string
  // The changelog id that was already dispatched.
  labelAdd?: string
  // Local time of the last scan, for pruning.
  seenAt?: string
}

type PollState = {
  // Local time of the last successful search, in Jira's offset form.
  cursor?: string
  emptyPasses?: number
  issues?: Record<string, CachedIssue>
}

type PassResult = {
  ready: number
  posted: number
  unchanged: number
  handled: number
  skipped: number
  dispatched: boolean
}

const minIntervalSeconds = 60
const maxIntervalSeconds = 900
const errorBaseSeconds = 120
const errorMaxSeconds = 1800
const overlapMs = 5 * 60_000
const cacheTtlMs = 30 * 24 * 3_600_000

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
  const statePath = join(cfg.stateDir, "poll.json")
  const state = loadState(statePath)
  const dryRun = options["dry-run"] === "true"
  const watch = options["watch"] === "true" && !dryRun
  const min = Math.max(
    10,
    positive(options["min-interval"] ?? Bun.env.JIRA_DISPATCH_POLL_MIN, minIntervalSeconds),
  )
  const max = Math.max(
    min,
    positive(options["max-interval"] ?? Bun.env.JIRA_DISPATCH_POLL_MAX, maxIntervalSeconds),
  )
  const override = firstOf("", options.jql, args[0])
  const jql = () => jqlFor(cfg, state, override)

  if (!watch) {
    const release = dryRun ? undefined : takeLock(cfg.stateDir)
    if (!dryRun && !release) {
      console.log("another poll is running")
      return
    }
    try {
      const result = await pass(cfg, secret, url, limit, state, jql(), dryRun)
      if (!dryRun) saveState(statePath, state)
      console.log(summary(result))
    } finally {
      release?.()
    }
    return
  }

  const release = takeLock(cfg.stateDir)
  if (!release) {
    console.log("another poll is running")
    return
  }

  let failures = 0
  try {
    for (;;) {
      let wait: number
      try {
        const result = await pass(cfg, secret, url, limit, state, jql(), false)
        state.emptyPasses = result.dispatched ? 0 : (state.emptyPasses ?? 0) + 1
        failures = 0
        saveState(statePath, state)
        wait = adaptiveInterval(state.emptyPasses, min, max)
        console.log(`${summary(result)}, next ${wait}s`)
      } catch (error) {
        failures++
        wait = errorInterval(failures)
        console.error(`poll failed: ${message(error)}; next ${wait}s`)
      }
      await sleepOrWake(wait)
    }
  } finally {
    release()
  }
}

// SIGHUP wakes the watch for an immediate pass, so a just-added label does not
// wait for the idle cap. A signal that arrives during a pass is dropped.
function sleepOrWake(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, seconds * 1000)
    function done(): void {
      clearTimeout(timer)
      process.off("SIGHUP", done)
      resolve()
    }
    process.once("SIGHUP", done)
  })
}

async function pass(
  cfg: Config,
  secret: string,
  url: string,
  limit: number,
  state: PollState,
  jql: string,
  dryRun: boolean,
): Promise<PassResult> {
  const startedAt = new Date()
  const issues = await search(jql, limit)
  const cache = (state.issues ??= {})
  const result: PassResult = {
    ready: issues.length,
    posted: 0,
    unchanged: 0,
    handled: 0,
    skipped: 0,
    dispatched: false,
  }

  for (const issue of issues) {
    const updated = issue.fields?.updated
    const cached = cache[issue.key]
    if (cached && updated && cached.updated === updated) {
      result.unchanged++
      if (!dryRun) cached.seenAt = new Date().toISOString()
      continue
    }

    const history = await latestLabelAdd(issue.key, cfg.triggerLabels)
    if (!history?.id) {
      result.skipped++
      console.log(`${issue.key.padEnd(12)} skipped: no label-add history`)
      if (!dryRun) cache[issue.key] = { updated, labelAdd: cached?.labelAdd, seenAt: now() }
      continue
    }

    if (cached?.labelAdd === history.id) {
      result.handled++
      console.log(`${issue.key.padEnd(12)} already handled ${history.id}`)
      if (!dryRun) cache[issue.key] = { updated, labelAdd: history.id, seenAt: now() }
      continue
    }

    if (dryRun) {
      result.posted++
      console.log(`${issue.key.padEnd(12)} would post ${history.id}`)
      continue
    }

    const body = JSON.stringify(toPayload(issue, history, cfg))
    const response = await postHook(url, secret, body)
    const kind = await kindOf(response)
    console.log(`${issue.key.padEnd(12)} ${response.status} ${kind}`)

    // A rejected event is not recorded by the receiver, so the cursor must not
    // move past it. The next pass retries it.
    if (kind === "rejected")
      throw new Error(`the receiver rejected ${issue.key}: ${response.status}`)

    if (kind === "dispatched" || kind === "duplicate" || kind === "in-flight") {
      result.posted++
      if (kind === "dispatched") result.dispatched = true
      cache[issue.key] = { updated, labelAdd: history.id, seenAt: now() }
    }
  }

  if (!dryRun) {
    state.cursor = jiraTimestamp(startedAt)
    prune(cache)
  }
  return result
}

// Jira sends the changelog id in a webhook, so the receiver dedupes a poll and a
// webhook delivery of the same event.
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

// Only ask Jira for issues that changed since the last successful pass. The
// five-minute overlap absorbs clock skew; the cache absorbs the overlap.
function jqlFor(cfg: Config, state: PollState, override: string): string {
  if (override) return override
  const cursor = Date.parse(state.cursor ?? "")
  if (Number.isNaN(cursor)) return readyJql(cfg)
  return readyJql(cfg, jiraTimestamp(new Date(cursor - overlapMs)))
}

function jiraTimestamp(date: Date): string {
  return date.toISOString().replace("Z", "+0000")
}

// One pass with no dispatch moves one step down the ladder. A dispatch resets
// it. Jitter keeps the passes from landing on the same second every time.
function adaptiveInterval(emptyPasses: number, min: number, max: number): number {
  const steps = [min, Math.min(max, 120), Math.min(max, 300), Math.min(max, 600), max]
  return jitter(steps[Math.min(emptyPasses, steps.length - 1)])
}

function errorInterval(failures: number): number {
  return jitter(Math.min(errorMaxSeconds, errorBaseSeconds * 2 ** Math.min(failures - 1, 4)))
}

function jitter(seconds: number): number {
  return Math.round(seconds * (0.9 + Math.random() * 0.2))
}

function positive(value: string | undefined, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function summary(result: PassResult): string {
  return `pass: ${result.ready} ready, ${result.posted} posted, ${result.unchanged} unchanged, ${result.handled} handled, ${result.skipped} skipped`
}

function loadState(path: string): PollState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PollState
  } catch {
    return {}
  }
}

function saveState(path: string, state: PollState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

function prune(cache: Record<string, CachedIssue>): void {
  const cutoff = Date.now() - cacheTtlMs
  for (const [key, entry] of Object.entries(cache)) {
    const seen = Date.parse(entry.seenAt ?? "")
    if (Number.isNaN(seen) || seen < cutoff) delete cache[key]
  }
}

// A single-flight lock. The watch process holds it for its lifetime. A killed
// process leaves a stale pid, which the next run detects and removes.
function takeLock(stateDir: string): (() => void) | undefined {
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, "poll.lock")
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" })
      return () => {
        try {
          rmSync(path)
        } catch {
          // already gone
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const pid = Number(readFileSync(path, "utf8").trim())
      if (pid && pid !== process.pid && alive(pid)) return undefined
      rmSync(path)
    }
  }
  return undefined
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function now(): string {
  return new Date().toISOString()
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
