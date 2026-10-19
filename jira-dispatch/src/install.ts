import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { $ } from "bun"
import { secretFilePath } from "./secret.ts"

const label = "com.ht2knock.jira-dispatch"

export async function installCommand(configPath: string, dryRun: boolean): Promise<void> {
  mkdirSync(dirname(configPath), { recursive: true })
  writeConfig(configPath)
  writeSecretFile(secretFilePath())

  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
  mkdirSync(dirname(plist), { recursive: true })
  const program = selfCommand()
  writeFileSync(plist, renderPlist(program))
  console.log(`wrote ${plist}`)

  if (dryRun) {
    console.log(`dry run: skipped launchctl; the agent runs\n  ${program.join(" ")}`)
    return
  }

  const domain = `gui/${process.getuid?.() ?? 0}`
  await $`launchctl bootout ${domain}/${label}`.quiet().nothrow()
  await $`launchctl bootstrap ${domain} ${plist}`.quiet()
  console.log("agent loaded")
  console.log(
    `\nnext:\n  1. put the webhook secret in ${secretFilePath()}\n  2. edit ${configPath}\n  3. jira-dispatch work-mode on\n  4. expose the port, then create the Jira webhook`,
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

function renderPlist(program: string[]): string {
  const args = program.map((arg) => `        <string>${escapeXml(arg)}</string>`).join("\n")
  const logs = join(homedir(), "Library", "Logs", "jira-dispatch.log")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logs)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logs)}</string>
</dict>
</plist>
`
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
