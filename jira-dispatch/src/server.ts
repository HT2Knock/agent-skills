import { loadConfig, secret, workModeOn } from "./config.ts"
import { Dispatcher } from "./dispatch.ts"
import { Kind, evaluate, parsePayload, verifySignature } from "./hook.ts"

const maxBodyBytes = 1 << 20
const configPath = process.env.JIRA_DISPATCH_CONFIG ?? "config.json"

const cfg = loadConfig(configPath)
const webhookSecret = secret(cfg)
const dispatcher = new Dispatcher(cfg, log)

function log(text: string): void {
  process.stderr.write(`${new Date().toISOString()} ${text}\n`)
}

function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  })
}

function rejected(status: number, reason: string): Response {
  return json(status, { kind: Kind.Rejected, reason })
}

async function readBody(req: Request): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > maxBodyBytes) return null
  const raw = Buffer.from(await req.arrayBuffer())
  return raw.length > maxBodyBytes ? null : raw
}

function statusFor(kind: string): number {
  if (kind === Kind.Dispatch) return 202
  if (kind === Kind.Rejected) return 500
  return 200
}

async function handleHook(req: Request): Promise<Response> {
  const raw = await readBody(req)
  if (!raw) return rejected(413, "body too large")

  if (!verifySignature(webhookSecret, raw, req.headers.get("x-hub-signature"))) {
    log("rejected an unsigned or wrongly signed request")
    return rejected(401, "bad or missing signature")
  }

  const text = raw.toString("utf8")
  let payload
  try {
    payload = parsePayload(text)
  } catch (error) {
    return rejected(400, (error as Error).message)
  }

  let decision = evaluate(
    {
      workModeOn: workModeOn(cfg),
      allowedEvents: cfg.allowedEvents,
      allowedActors: cfg.allowedActors,
      triggerLabels: cfg.triggerLabels,
      projects: cfg.projects,
    },
    payload,
  )
  if (decision.kind === Kind.Dispatch) {
    // Recording an ignored event would make its retry a duplicate after work mode
    // turns on.
    decision = dispatcher.dispatch(payload, text)
  }

  log(`${payload.webhookEvent} ${payload.issue.key} -> ${decision.kind} (${decision.reason})`)
  return json(statusFor(decision.kind), {
    kind: decision.kind,
    reason: decision.reason,
    key: payload.issue.key,
  })
}

function health(): Response {
  return json(200, {
    kind: "ok",
    reason: workModeOn(cfg) ? "work mode on" : "work mode off",
  })
}

const [hostname, portText] = cfg.listen.split(":")
const server = Bun.serve({
  hostname,
  port: Number(portText),
  routes: {
    "/healthz": { GET: health },
    "/jira/hook": { POST: handleHook },
  },
  fetch: () => rejected(404, "not found"),
})

// The test reads this line to learn the port when the config asks for 0.
console.log(`listening on http://${server.hostname}:${server.port}`)
