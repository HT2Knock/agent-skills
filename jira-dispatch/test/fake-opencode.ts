// Stands in for the OpenCode server so the end-to-end check runs offline. It
// records every request; the check reads that record to prove what the receiver
// asked for.
import { appendFileSync } from "node:fs"

const logPath = process.env.FAKE_LOG
if (!logPath) throw new Error("FAKE_LOG must name a file")

// The wait call sleeps, so the check can prove the ticket lock is held for the
// whole session and not only until the prompt is accepted.
const waitMs = Number(process.env.FAKE_WAIT_MS ?? "2000")
const sessionID = "ses_fake0001"

const record = (line: string): void => {
  appendFileSync(logPath, `${line}\n`)
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text()
    record(`${req.method} ${url.pathname} ${body.replace(/\s+/g, " ").trim()}`)

    if (req.method === "POST" && url.pathname === "/api/session") {
      const input = JSON.parse(body) as { title?: string; location?: { directory?: string } }
      return Response.json({
        data: {
          id: sessionID,
          title: input.title ?? "",
          projectID: "proj_fake",
          cost: 0,
          tokens: {},
          time: {},
          location: { directory: input.location?.directory ?? "" },
        },
      })
    }

    if (req.method === "POST" && url.pathname === `/api/session/${sessionID}/prompt`) {
      return Response.json({ data: { id: "inbox_fake" } })
    }

    if (req.method === "POST" && url.pathname.endsWith("/wait")) {
      await Bun.sleep(waitMs)
      return new Response(null, { status: 200 })
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      return Response.json({ data: [] })
    }

    return Response.json(
      { error: "unexpected", method: req.method, path: url.pathname },
      { status: 404 },
    )
  },
})

// The check reads this to learn the assigned port.
console.log(`fake opencode on http://127.0.0.1:${server.port}`)
