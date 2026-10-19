import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// One accepted ticket becomes one OpenCode session in one workspace.
export type Project = {
  // {key} and {project} are expanded before use.
  workspace: string
  // Defaults to workspace.
  prepareDir?: string
  // Runs once before the session, argv form, no shell. A failure stops the run.
  prepare?: string[]
  // Placeholders: {key} {project} {summary} {url} {workspace}
  promptTemplate: string
}

export type Config = {
  listen: string
  // Names the environment variable that holds the webhook secret.
  secretEnv: string
  stateDir: string
  // A marker file. When it does not exist, the receiver accepts events and starts nothing.
  workModePath: string
  jiraBaseUrl?: string
  // Emails or account ids whose events may start a session. Must not be empty.
  allowedActors: string[]
  allowedEvents: string[]
  // The issue must carry one of these. Empty means any.
  triggerLabels: string[]
  // A lock older than this is stale, which covers a receiver that died mid-run.
  lockTtlHours: number
  opencode?: {
    // Omit it to use the local background service.
    baseUrl?: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
  }
  projects: Record<string, Project>
}

const TOP_LEVEL_KEYS = new Set([
  "listen",
  "secretEnv",
  "stateDir",
  "workModePath",
  "jiraBaseUrl",
  "allowedActors",
  "allowedEvents",
  "triggerLabels",
  "lockTtlHours",
  "opencode",
  "projects",
])

const PROJECT_KEYS = new Set(["workspace", "prepareDir", "prepare", "promptTemplate"])

function expandHome(path: string): string {
  if (!path) return path
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function defaults(): Config {
  return {
    listen: "127.0.0.1:8787",
    secretEnv: "JIRA_WEBHOOK_SECRET",
    stateDir: join(homedir(), ".local", "state", "jira-dispatch"),
    workModePath: join(homedir(), ".local", "state", "agent-work-mode"),
    allowedActors: [],
    allowedEvents: ["jira:issue_assigned", "jira:issue_updated"],
    triggerLabels: ["agent-ready"],
    lockTtlHours: 6,
    projects: {},
  }
}

// An unknown key is an error, so a typo fails loudly at start.
export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new Error(`parse ${path}: ${(error as Error).message}`)
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`parse ${path}: unknown key "${key}"`)
  }

  const cfg: Config = { ...defaults(), ...(parsed as Partial<Config>) }

  cfg.stateDir = expandHome(cfg.stateDir)
  cfg.workModePath = expandHome(cfg.workModePath)

  for (const [key, project] of Object.entries(cfg.projects)) {
    for (const field of Object.keys(project)) {
      if (!PROJECT_KEYS.has(field)) throw new Error(`project ${key}: unknown key "${field}"`)
    }
    project.workspace = expandHome(project.workspace)
    project.prepareDir = expandHome(project.prepareDir ?? project.workspace)
  }

  validate(cfg)
  return cfg
}

function validate(cfg: Config): void {
  if (!cfg.secretEnv) throw new Error("secretEnv must name an environment variable")
  if (!cfg.listen) throw new Error("listen must not be empty")
  // This is the only filter that fails open when empty. An empty list would let
  // any Jira user who can add the trigger label start an auto-approved session.
  if (cfg.allowedActors.length === 0) {
    throw new Error("allowedActors must name at least one account, or every actor is accepted")
  }
  if (Object.keys(cfg.projects).length === 0) {
    throw new Error("projects must map at least one Jira project key")
  }
  for (const [key, project] of Object.entries(cfg.projects)) {
    if (!project.workspace) throw new Error(`project ${key}: workspace must not be empty`)
    if (!project.promptTemplate) throw new Error(`project ${key}: promptTemplate must not be empty`)
  }
}

export function secret(cfg: Config): string {
  const value = process.env[cfg.secretEnv] ?? ""
  if (!value) throw new Error(`environment variable ${cfg.secretEnv} is empty`)
  return value
}

// A missing marker means work is off, so the receiver starts nothing.
export function workModeOn(cfg: Config): boolean {
  return existsSync(cfg.workModePath)
}
