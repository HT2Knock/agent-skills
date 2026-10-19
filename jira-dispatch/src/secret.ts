import { readFileSync } from "node:fs"
import { defaultSecretPath } from "./config.ts"

export function secretFilePath(): string {
  return Bun.env.JIRA_DISPATCH_SECRET_FILE || defaultSecretPath()
}

// The environment wins, so a shell export beats the file.
export function readSecret(name: string): string {
  const value = Bun.env[name] || readSecretFile(name)
  if (!value) throw new Error(`${name} is not set; export it or put it in ${secretFilePath()}`)
  return value
}

function readSecretFile(name: string): string {
  try {
    return parseEnvFile(readFileSync(secretFilePath(), "utf8"))[name] ?? ""
  } catch {
    return ""
  }
}

// KEY=value per line. A '#' at the start of a line is a comment.
function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=")
    if (eq <= 0 || line.trimStart().startsWith("#")) continue
    values[line.slice(0, eq).trim()] = unquote(line.slice(eq + 1).trim())
  }
  return values
}

function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value)
  return match ? match[2] : value
}
