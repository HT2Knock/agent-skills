import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config, Project } from "./config.ts"
import { Kind, browseUrl, eventId, projectKey, type Decision, type Payload } from "./hook.ts"
import { getClient, type Client } from "./opencode.ts"

type RunRecord = {
  key: string
  project: string
  eventId: string
  event: string
  actor: string
  summary: string
  url: string
  workspace: string
  stamp: string
  prompt: string
  sessionID?: string
  spoolFile: string
  startedAt: string
}

// A single pass, so a value that contains a placeholder is not scanned again.
function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class Dispatcher {
  constructor(
    private readonly cfg: Config,
    private readonly log: (text: string) => void,
  ) {}

  private at(...parts: string[]): string {
    return join(this.cfg.stateDir, ...parts)
  }

  private seenPath(p: Payload): string {
    const digest = createHash("sha256").update(eventId(p)).digest("hex")
    return this.at("seen", `${digest}.json`)
  }

  private runPath(record: RunRecord): string {
    return this.at("runs", `${record.stamp}.${record.key}.json`)
  }

  private saveRun(record: RunRecord): void {
    writeFileSync(this.runPath(record), `${JSON.stringify(record, null, 2)}\n`)
  }

  // Returns true when the event was already recorded. The exclusive create means
  // two concurrent deliveries cannot both win.
  markSeen(p: Payload): boolean {
    mkdirSync(this.at("seen"), { recursive: true })
    try {
      writeFileSync(this.seenPath(p), JSON.stringify(p), { flag: "wx" })
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return true
      throw error
    }
  }

  unmarkSeen(p: Payload): void {
    try {
      rmSync(this.seenPath(p))
    } catch {
      // already gone
    }
  }

  // A lock older than lockTtlHours is stale and is taken over.
  private acquireLock(key: string): boolean {
    mkdirSync(this.at("lock"), { recursive: true })
    const file = this.at("lock", key)
    if (this.createExclusive(file)) return true
    if (Date.now() - statSync(file).mtimeMs < this.cfg.lockTtlHours * 3_600_000) return false
    this.log(`lock for ${key} is older than the TTL, taking it over`)
    rmSync(file)
    return this.createExclusive(file)
  }

  private createExclusive(file: string): boolean {
    try {
      writeFileSync(file, `${new Date().toISOString()}\n`, { flag: "wx" })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
  }

  releaseLock(key: string): void {
    try {
      rmSync(this.at("lock", key))
    } catch {
      // already gone
    }
  }

  // Returns once the local bookkeeping is durable, so the webhook endpoint
  // answers before Jira times out. The session runs in the background.
  dispatch(p: Payload, raw: string): Decision {
    let seen: boolean
    try {
      seen = this.markSeen(p)
    } catch (error) {
      return { kind: Kind.Rejected, reason: `cannot record the event: ${message(error)}` }
    }
    if (seen) return { kind: Kind.Duplicate, reason: `event already handled: ${eventId(p)}` }

    // Every failure past this point unmarks the event, so a Jira retry is not
    // swallowed by the dedupe set.
    const reject = (reason: string): Decision => {
      this.unmarkSeen(p)
      return { kind: Kind.Rejected, reason }
    }

    let locked: boolean
    try {
      locked = this.acquireLock(p.issue.key)
    } catch (error) {
      return reject(`cannot take the lock: ${message(error)}`)
    }
    if (!locked) {
      return { kind: Kind.InFlight, reason: `a run for ${p.issue.key} is already in flight` }
    }

    const key = p.issue.key
    const projectKeyName = projectKey(p)
    const template = this.cfg.projects[projectKeyName]
    const workspace = substitute(template.workspace, { key, project: projectKeyName })
    const project: Project = {
      ...template,
      workspace,
      prepareDir: substitute(template.prepareDir ?? workspace, { key, project: projectKeyName }),
    }

    try {
      mkdirSync(workspace, { recursive: true })
    } catch (error) {
      return reject(`cannot create the workspace: ${message(error)}`)
    }

    let record: RunRecord
    try {
      record = this.recordRun(p, project, raw)
    } catch (error) {
      return reject(`cannot write the run record: ${message(error)}`)
    }

    void this.run(record, project)
    return { kind: Kind.Dispatch, reason: `started a session for ${key}` }
  }

  private recordRun(p: Payload, project: Project, raw: string): RunRecord {
    for (const dir of ["runs", "spool", "logs"]) mkdirSync(this.at(dir), { recursive: true })

    const summary = p.issue.fields?.summary ?? ""
    const url = browseUrl(p, this.cfg.jiraBaseUrl)
    const startedAt = new Date().toISOString()
    const stamp = startedAt.replace(/[:.]/g, "-")
    const prompt = substitute(project.promptTemplate, {
      key: p.issue.key,
      project: projectKey(p),
      summary,
      url,
      workspace: project.workspace,
    })

    const spoolFile = this.at("spool", `${p.issue.key}.${stamp}.json`)
    writeFileSync(spoolFile, raw)
    writeFileSync(this.at("spool", `${p.issue.key}.${stamp}.prompt.txt`), prompt)

    const record: RunRecord = {
      key: p.issue.key,
      project: projectKey(p),
      eventId: eventId(p),
      event: p.webhookEvent,
      actor: p.user?.emailAddress ?? p.user?.accountId ?? "",
      summary,
      url,
      workspace: project.workspace,
      stamp,
      prompt,
      spoolFile,
      startedAt,
    }
    this.saveRun(record)
    return record
  }

  // The ticket lock is held until the session finishes.
  private async run(record: RunRecord, project: Project): Promise<void> {
    const logFile = this.at("logs", `${record.key}.${record.stamp}.log`)
    const write = (text: string): void => {
      appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`)
      this.log(`${record.key}: ${text}`)
    }

    try {
      const values = {
        key: record.key,
        project: record.project,
        summary: record.summary,
        url: record.url,
        workspace: record.workspace,
      }

      if (project.prepare?.length) {
        const argv = project.prepare.map((arg) => substitute(arg, values))
        write(`$ ${argv.join(" ")}`)
        const result = Bun.spawnSync(argv, {
          cwd: project.prepareDir,
          stdout: "pipe",
          stderr: "pipe",
        })
        if (result.exitCode !== 0) {
          write(`prepare failed: ${result.stderr.toString().trim()}`)
          return
        }
      }

      const client = await getClient(this.cfg)
      const created = (await client.session.create({
        title: record.key,
        location: { directory: project.workspace },
        ...(this.cfg.opencode?.agent ? { agent: this.cfg.opencode.agent } : {}),
        ...(this.cfg.opencode?.model ? { model: this.cfg.opencode.model } : {}),
      })) as unknown as { data?: { id?: string }; id?: string }
      // The generated client unwraps the { data } envelope for some endpoints
      // but not all. Accept both.
      const sessionID = created.data?.id ?? created.id
      if (!sessionID) {
        throw new Error(`session create returned no id: ${JSON.stringify(created).slice(0, 200)}`)
      }

      record.sessionID = sessionID
      this.saveRun(record)
      write(`session ${sessionID} created in ${project.workspace}`)

      await client.session.prompt({ sessionID, text: record.prompt })
      write("prompt accepted, waiting for the session")

      await waitForSession(client, sessionID, write)
      write("session finished")
    } catch (error) {
      write(`run failed: ${message(error)}`)
    } finally {
      this.releaseLock(record.key)
    }
  }
}

const waitPollMs = 30_000
const waitMaxMs = 6 * 3_600_000

// The wait route has a server-side timeout. A slow model can exceed it while
// the session keeps running, so a timeout must not release the ticket lock.
async function waitForSession(
  client: Client,
  sessionID: string,
  write: (text: string) => void,
): Promise<void> {
  try {
    await client.session.wait({ sessionID })
    return
  } catch (error) {
    if (!isWaitTimeout(error)) throw error
    write("wait timed out; holding the lock until the session ends")
  }

  const deadline = Date.now() + waitMaxMs
  while (Date.now() < deadline) {
    await Bun.sleep(waitPollMs)
    try {
      const active = (await client.session.active()) as unknown as Record<string, { type?: string }>
      if (active[sessionID]?.type !== "running") {
        write("session ended after the wait timeout")
        return
      }
    } catch (error) {
      write(`session check failed: ${message(error)}; retrying`)
    }
  }
  write("session is still running after 6h; releasing the lock")
}

function isWaitTimeout(error: unknown): boolean {
  return /timed out|timeout/i.test(message(error))
}
