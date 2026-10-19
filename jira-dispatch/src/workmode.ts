import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { expandHome, loadConfig } from "./config.ts"

export function workModeCommand(configPath: string, args: string[]): void {
  const marker = resolveMarker(configPath)
  const run = actions[args[0] ?? "status"]
  if (!run) {
    console.error("usage: jira-dispatch work-mode [on|off|status]")
    process.exit(2)
  }
  run(marker)
}

const actions: Record<string, (marker: string) => void> = {
  on(marker) {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, "")
    console.log(`work mode on (${marker})`)
  },
  off(marker) {
    rmSync(marker, { force: true })
    console.log("work mode off")
  },
  status(marker) {
    console.log(existsSync(marker) ? "work mode on" : "work mode off")
  },
}

function resolveMarker(configPath: string): string {
  const override = Bun.env.JIRA_DISPATCH_WORK_MODE
  if (override) return expandHome(override)
  try {
    return loadConfig(configPath).workModePath
  } catch {
    return join(homedir(), ".local", "state", "agent-work-mode")
  }
}
