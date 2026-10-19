// jira-dispatch receives Jira Cloud webhooks and starts one OpenCode session
// per accepted ticket.
//
// It verifies the webhook signature, filters the event, records it, and drives
// the session in the background. It answers the webhook before the session
// finishes, because Jira times out a slow endpoint.
import { loadConfig, secret, workModeOn } from "./config.ts"
import { Dispatcher } from "./dispatch.ts"
import { Kind, evaluate, parsePayload, verifySignature } from "./hook.ts"

const maxBodyBytes = 1 << 20

const configPath = process.env.JIRA_DISPATCH_CONFIG ?? "config.json"

function log(text: string): void {
  process.stderr.write(`${new Date().toISOString()} ${text}\n`)
}

const cfg = loadConfig(configPath)
const webhookSecret = secret(cfg)
const dispatcher = new Dispatcher(cfg, log)

function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function handleHook(req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > maxBodyBytes) {
    return json(413, { kind: "rejected", reason: "body too large" })
  }

  const raw = Buffer.from(await req.arrayBuffer())
  if (raw.length > maxBodyBytes) {
    return json(413, { kind: "rejected", reason: "body too large" })
  }

  if (!verifySignature(webhookSecret, raw, req.headers.get("x-hub-signature"))) {
    log(`rejected an unsigned or wrongly signed request`)
    return json(401, { kind: "rejected", reason: "bad or missing signature" })
  }

  let payload
  try {
    payload = parsePayload(raw.toString("utf8"))
  } catch (error) {
    return json(400, { kind: "rejected", reason: (error as Error).message })
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
    // An ignored event is not recorded. The secret is the trust boundary: only
    // Jira can sign a body, so a replay is not a new risk, and recording
    // ignored events would drop the ones that arrive while work mode is off.
    decision = dispatcher.dispatch(payload, raw.toString("utf8"))
  }

  let status = 200
  if (decision.kind === Kind.Dispatch) status = 202
  // Ask Jira to retry, instead of dropping the event.
  else if (decision.kind === Kind.Rejected) status = 500

  log(`${payload.webhookEvent} ${payload.issue.key} -> ${decision.kind} (${decision.reason})`)
  return json(status, { kind: decision.kind, reason: decision.reason, key: payload.issue.key })
}

const [hostname, portText] = cfg.listen.split(":")
const server = Bun.serve({
  hostname,
  port: Number(portText),
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (req.method === "GET" && pathname === "/healthz") {
      return json(200, { kind: "ok", reason: workModeOn(cfg) ? "work mode on" : "work mode off" })
    }
    if (req.method === "POST" && pathname === "/jira/hook") {
      return handleHook(req)
    }
    return json(404, { kind: "rejected", reason: "not found" })
  },
})

// The tests read this line to learn the port when the config asks for 0.
console.log(`listening on http://${server.hostname}:${server.port}`)
