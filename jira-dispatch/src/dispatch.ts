import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config, Project } from "./config.ts"
import { Kind, browseUrl, eventId, projectKey, type Decision, type Payload } from "./hook.ts"
import { getClient } from "./opencode.ts"

// RunRecord is written before the session starts. It is the evidence that a
// ticket was dispatched.
export type RunRecord = {
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

// substitute replaces {name} placeholders. It is a single pass, so a value that
// contains a placeholder is not scanned again.
export function substitute(text: string, values: Record<string, string>): string {
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

  // markSeen records the event id. It returns true when the event was already
  // recorded. The create is exclusive, so two concurrent deliveries cannot both
  // win.
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

  // unmarkSeen forgets the event id, so a later retry can be dispatched.
  unmarkSeen(p: Payload): void {
    try {
      rmSync(this.seenPath(p))
    } catch {
      // already gone
    }
  }

  // lockHeld reports whether a run for this ticket is still in flight. The lock
  // lives for the whole session. A lock older than lockTtlHours is stale, which
  // covers a receiver that died mid-run, and is taken over.
  lockHeld(key: string): boolean {
    mkdirSync(this.at("lock"), { recursive: true })
    const file = this.at("lock", key)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, `${new Date().toISOString()}\n`, { flag: "wx" })
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      if (Date.now() - statSync(file).mtimeMs < this.cfg.lockTtlHours * 3_600_000) return true
      this.log(`lock for ${key} is older than the TTL, taking it over`)
      rmSync(file)
    }
    return false
  }

  releaseLock(key: string): void {
    try {
      rmSync(this.at("lock", key))
    } catch {
      // already gone
    }
  }

  // dispatch records the run, takes the per-ticket lock, and starts the session
  // in the background. It returns as soon as the local bookkeeping is durable,
  // so the webhook endpoint answers before Jira times out.
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

    let held: boolean
    try {
      held = this.lockHeld(p.issue.key)
    } catch (error) {
      return reject(`cannot take the lock: ${message(error)}`)
    }
    if (held) return { kind: Kind.InFlight, reason: `a run for ${p.issue.key} is already in flight` }

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

    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const prompt = substitute(project.promptTemplate, {
      key: p.issue.key,
      project: projectKey(p),
      summary: p.issue.fields?.summary ?? "",
      url: browseUrl(p, this.cfg.jiraBaseUrl),
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
      summary: p.issue.fields?.summary ?? "",
      url: browseUrl(p, this.cfg.jiraBaseUrl),
      workspace: project.workspace,
      stamp,
      prompt,
      spoolFile,
      startedAt: new Date().toISOString(),
    }
    writeFileSync(this.at("runs", `${stamp}.${p.issue.key}.json`), `${JSON.stringify(record, null, 2)}\n`)
    return record
  }

  // run prepares the workspace and drives the session. It runs in the
  // background, so the webhook has already been answered. The ticket lock is
  // held until the session finishes.
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
        workspace: project.workspace,
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
      // The generated client unwraps the { data } envelope for a
      // single-resource response, but not for every endpoint. Accept both.
      const sessionID = created.data?.id ?? created.id
      if (!sessionID) throw new Error(`session create returned no id: ${JSON.stringify(created).slice(0, 200)}`)

      record.sessionID = sessionID
      write(`session ${sessionID} created in ${project.workspace}`)

      await client.session.prompt({ sessionID, text: record.prompt })
      write("prompt accepted, waiting for the session")

      await client.session.wait({ sessionID })
      write("session finished")
    } catch (error) {
      write(`run failed: ${message(error)}`)
    } finally {
      this.releaseLock(record.key)
    }
  }
}
