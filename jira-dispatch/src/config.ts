import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Project holds everything that differs between Jira projects. One accepted
// ticket becomes one OpenCode session in one workspace.
export type Project = {
  // Workspace is the directory the session runs in. {key} and {project} are
  // expanded before use.
  workspace: string
  // PrepareDir is the directory prepare runs in. Defaults to workspace.
  prepareDir?: string
  // Prepare runs once before the session, argv form, no shell. A failure stops
  // the run.
  prepare?: string[]
  // PromptTemplate is the message sent to the session.
  // Placeholders: {key} {project} {summary} {url} {workspace}
  promptTemplate: string
}

export type Config = {
  listen: string
  // secretEnv names the environment variable that holds the webhook secret. The
  // secret itself never appears in this file.
  secretEnv: string
  stateDir: string
  // workModePath is a marker file. When it does not exist, the receiver accepts
  // events and starts nothing.
  workModePath: string
  jiraBaseUrl?: string
  // allowedActors lists the account emails or ids whose events may start a
  // session. Must not be empty.
  allowedActors: string[]
  allowedEvents: string[]
  // triggerLabels: the issue must carry one of these. Empty means any.
  triggerLabels: string[]
  // lockTtlHours bounds how long one ticket stays single-flight. A lock older
  // than this covers a receiver that died mid-session.
  lockTtlHours: number
  opencode?: {
    // baseUrl points at an OpenCode server. Omit it to use the local
    // background service.
    baseUrl?: string
    // agent and model are passed to session.create.
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

export function expandHome(path: string): string {
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

// loadConfig reads the file, fills the defaults, and checks that the result can
// run. An unknown key is an error, so a typo fails loudly at start.
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

  for (const [key, project] of Object.entries(cfg.projects ?? {})) {
    for (const field of Object.keys(project)) {
      if (!PROJECT_KEYS.has(field)) throw new Error(`project ${key}: unknown key "${field}"`)
    }
    project.workspace = expandHome(project.workspace)
    if (!project.prepareDir) {
      project.prepareDir = project.workspace
    } else {
      project.prepareDir = expandHome(project.prepareDir)
    }
  }

  validate(cfg)
  return cfg
}

function validate(cfg: Config): void {
  if (!cfg.secretEnv) throw new Error("secretEnv must name an environment variable")
  if (!cfg.listen) throw new Error("listen must not be empty")
  // This is the only filter that fails open when empty, and an empty list would
  // let any Jira user who can add the trigger label start an auto-approved
  // session. Require it.
  if (!cfg.allowedActors || cfg.allowedActors.length === 0) {
    throw new Error("allowedActors must name at least one account, or every actor is accepted")
  }
  if (!cfg.projects || Object.keys(cfg.projects).length === 0) {
    throw new Error("projects must map at least one Jira project key")
  }
  for (const [key, project] of Object.entries(cfg.projects)) {
    if (!project.workspace) throw new Error(`project ${key}: workspace must not be empty`)
    if (!project.promptTemplate) throw new Error(`project ${key}: promptTemplate must not be empty`)
  }
}

// secret reads the webhook secret from the configured environment variable.
export function secret(cfg: Config): string {
  const value = process.env[cfg.secretEnv] ?? ""
  if (!value) throw new Error(`environment variable ${cfg.secretEnv} is empty`)
  return value
}

// workModeOn reports whether the work-mode marker file exists. A missing marker
// means "not at work", so the receiver starts nothing.
export function workModeOn(cfg: Config): boolean {
  return existsSync(cfg.workModePath)
}
