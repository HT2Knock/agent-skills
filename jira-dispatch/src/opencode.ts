import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Config } from "./config.ts"

// The generated client type is not exported under a stable name, so the shape
// is inferred from OpenCode.make.
export type Client = ReturnType<typeof OpenCode.make>

let cached: Client | undefined

// getClient returns the OpenCode client. With opencode.baseUrl set it talks to
// that server; otherwise it discovers or starts the local background service,
// exactly as the CLI does.
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
