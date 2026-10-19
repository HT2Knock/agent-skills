import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { $ } from "bun"
import { secretFilePath } from "./secret.ts"

const label = "com.ht2knock.jira-dispatch"
const pollLabel = "com.ht2knock.jira-dispatch-poll"

// launchd gives an agent a minimal PATH. The poll agent calls atlassian-cli,
// and the receiver may start the opencode service, so the brew and local bins
// must be present.
const servicePath = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  join(homedir(), ".local", "bin"),
].join(":")

export async function installCommand(configPath: string, dryRun: boolean): Promise<void> {
  mkdirSync(dirname(configPath), { recursive: true })
  writeConfig(configPath)
  writeSecretFile(secretFilePath())

  const program = selfCommand()
  const servePlist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
  const pollPlist = join(homedir(), "Library", "LaunchAgents", `${pollLabel}.plist`)
  mkdirSync(dirname(servePlist), { recursive: true })

  writeFileSync(
    servePlist,
    renderPlist(label, program, {
      logs: join(homedir(), "Library", "Logs", "jira-dispatch.log"),
      keepAlive: true,
    }),
  )
  const pollProgram = withCommand(program, "poll", "--watch")
  writeFileSync(
    pollPlist,
    renderPlist(pollLabel, pollProgram, {
      logs: join(homedir(), "Library", "Logs", "jira-dispatch-poll.log"),
      keepAlive: true,
    }),
  )
  console.log(`wrote ${servePlist}`)
  console.log(`wrote ${pollPlist}`)

  if (dryRun) {
    console.log(
      `dry run: skipped launchctl; the agents run\n  ${program.join(" ")}\n  ${pollProgram.join(" ")}`,
    )
    return
  }

  const domain = `gui/${process.getuid?.() ?? 0}`
  for (const [name, path] of [
    [label, servePlist],
    [pollLabel, pollPlist],
  ]) {
    await reload(domain, name, path)
  }
  console.log("agents loaded")
  console.log(
    `\nnext:\n  1. put the webhook secret in ${secretFilePath()}\n  2. edit ${configPath}\n  3. jira-dispatch work-mode on\n  4. add a trigger label to a ticket; the poll agent checks from 60s to 15m, faster when work is flowing`,
  )
}

function writeConfig(path: string): void {
  if (existsSync(path)) {
    console.log(`${path} exists, leaving it alone`)
    return
  }
  const example = {
    allowedActors: ["you@example.com"],
    projects: { PROJ: { workspace: "~/src/PROJ" } },
  }
  writeFileSync(path, `${JSON.stringify(example, null, 2)}\n`)
  console.log(`wrote ${path} -- set allowedActors and your projects`)
}

function writeSecretFile(path: string): void {
  if (existsSync(path)) {
    console.log(`${path} exists, leaving it alone`)
    return
  }
  writeFileSync(path, "JIRA_WEBHOOK_SECRET=\n", { mode: 0o600 })
  console.log(`wrote ${path} -- put the Jira webhook secret in it`)
}

// A compiled binary is its own program. A source checkout runs under bun.
function selfCommand(): string[] {
  const exec = process.execPath
  const name = basename(exec)
  const source = name === "bun" || name.startsWith("bun-")
  return source ? [exec, "run", Bun.main, "serve"] : [exec, "serve"]
}

function withCommand(program: string[], command: string, ...args: string[]): string[] {
  return [...program.slice(0, -1), command, ...args]
}

// bootout is asynchronous. A bootstrap before the old service is gone fails
// with exit code 5, so wait for print to stop finding the label.
async function reload(domain: string, name: string, path: string): Promise<void> {
  await $`launchctl bootout ${domain}/${name}`.quiet().nothrow()
  for (let i = 0; i < 50; i++) {
    const loaded = await $`launchctl print ${domain}/${name}`.quiet().nothrow()
    if (loaded.exitCode !== 0) break
    await Bun.sleep(100)
  }
  await $`launchctl bootstrap ${domain} ${path}`.quiet()
}

type PlistOptions = {
  logs: string
  keepAlive?: boolean
}

function renderPlist(name: string, program: string[], options: PlistOptions): string {
  const args = program.map((arg) => `        <string>${escapeXml(arg)}</string>`).join("\n")
  const keepAlive = options.keepAlive ? "\n    <key>KeepAlive</key>\n    <true/>" : ""
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${name}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>${keepAlive}
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(servicePath)}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(options.logs)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(options.logs)}</string>
</dict>
</plist>
`
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
