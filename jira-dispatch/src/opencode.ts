import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Config } from "./config.ts"

// The generated client type has no stable export name.
export type Client = ReturnType<typeof OpenCode.make>

let cached: Client | undefined

// With no baseUrl, discover or start the local background service, as the CLI does.
export async function getClient(cfg: Config): Promise<Client> {
  if (cached) return cached
  if (cfg.opencode?.baseUrl) {
    cached = OpenCode.make({ baseUrl: cfg.opencode.baseUrl })
    return cached
  }
  const endpoint = await Service.ensure()
  cached = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  return cached
}
