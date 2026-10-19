import { workModeOn, type Config } from "./config.ts"
import { Dispatcher } from "./dispatch.ts"
import { Kind, evaluate, parsePayload, verifySignature } from "./hook.ts"
import { readSecret } from "./secret.ts"

const maxBodyBytes = 1 << 20

type Context = {
  cfg: Config
  secret: string
  dispatcher: Dispatcher
  log: (text: string) => void
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

async function handleHook(req: Request, ctx: Context): Promise<Response> {
  const raw = await readBody(req)
  if (!raw) return rejected(413, "body too large")

  if (!verifySignature(ctx.secret, raw, req.headers.get("x-hub-signature"))) {
    ctx.log("rejected an unsigned or wrongly signed request")
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
      workModeOn: workModeOn(ctx.cfg),
      allowedEvents: ctx.cfg.allowedEvents,
      allowedActors: ctx.cfg.allowedActors,
      triggerLabels: ctx.cfg.triggerLabels,
      projects: ctx.cfg.projects,
    },
    payload,
  )
  if (decision.kind === Kind.Dispatch) {
    // Recording an ignored event would make its retry a duplicate after work mode
    // turns on.
    decision = ctx.dispatcher.dispatch(payload, text)
  }

  ctx.log(`${payload.webhookEvent} ${payload.issue.key} -> ${decision.kind} (${decision.reason})`)
  return json(statusFor(decision.kind), {
    kind: decision.kind,
    reason: decision.reason,
    key: payload.issue.key,
  })
}

function health(ctx: Context): Response {
  return json(200, { kind: "ok", reason: workModeOn(ctx.cfg) ? "work mode on" : "work mode off" })
}

export function serve(cfg: Config, log: (text: string) => void): void {
  const ctx: Context = {
    cfg,
    secret: readSecret(cfg.secretEnv),
    dispatcher: new Dispatcher(cfg, log),
    log,
  }
  const [hostname, portText] = cfg.listen.split(":")

  const server = Bun.serve({
    hostname,
    port: Number(portText),
    routes: {
      "/healthz": { GET: () => health(ctx) },
      "/jira/hook": { POST: (req) => handleHook(req, ctx) },
    },
    fetch: () => rejected(404, "not found"),
  })

  // The test reads this line to learn the port when the config asks for 0.
  console.log(`listening on http://${server.hostname}:${server.port}`)
}
