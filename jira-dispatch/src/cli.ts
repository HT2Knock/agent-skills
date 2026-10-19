import { catchupCommand } from "./catchup.ts"
import { defaultConfigPath, loadConfig } from "./config.ts"
import { installCommand } from "./install.ts"
import { pollCommand } from "./poll.ts"
import { serve } from "./server.ts"
import { or } from "./values.ts"
import { workModeCommand } from "./workmode.ts"

const usage = `jira-dispatch - turn a Jira webhook into one OpenCode session

Usage: jira-dispatch [command] [options]

Commands:
  serve                    Run the webhook receiver (default)
  poll                     Dispatch tickets whose changelog shows a new trigger label
  catchup                  Dispatch tickets that became ready while the receiver was down
  work-mode [on|off|status]
  install                  Write the config, the secret file and the launchd agents
  help

Options:
  --config <path>          Config file (default: ~/.config/jira-dispatch/config.json)
  --jql <jql>              poll, catchup: override the JQL query
  --limit <n>              poll, catchup: maximum issues (default: 50)
  --url <url>              poll, catchup: receiver URL (default: http://<listen>/jira/hook)
  --interval <seconds>     poll: repeat every N seconds (default: run once)
  --dry-run                install: write the files, skip launchctl
                           poll: print what would be posted
`

type Options = Record<string, string>
type Command = (args: string[], options: Options, configPath: string) => Promise<void> | void

function log(text: string): void {
  process.stderr.write(`${new Date().toISOString()} ${text}\n`)
}

function help(): void {
  console.log(usage)
}

const commands: Record<string, Command> = {
  serve: (_args, _options, path) => serve(loadConfig(path), log),
  poll: (args, options, path) => pollCommand(path, options, args),
  catchup: (args, options, path) => catchupCommand(path, options, args),
  "work-mode": (args, _options, path) => workModeCommand(path, args),
  install: (_args, options, path) => installCommand(path, options["dry-run"] === "true"),
  help: () => help(),
}

async function main(): Promise<void> {
  const { options, positional } = parseArgs(Bun.argv.slice(2))
  const command = commands[or(positional[0], "serve")]
  if (!command || options.help) {
    help()
    return
  }
  const path = or(options.config, or(Bun.env.JIRA_DISPATCH_CONFIG, defaultConfigPath()))
  await command(positional.slice(1), options, path)
}

function parseArgs(argv: string[]): { options: Options; positional: string[] } {
  const options: Options = {}
  const positional: string[] = []
  const valueFlags = new Set(["config", "jql", "limit", "url", "interval"])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const value = valueFlags.has(name) ? argv[++i] : undefined
    options[name] = or(value, "true")
  }
  return { options, positional }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
