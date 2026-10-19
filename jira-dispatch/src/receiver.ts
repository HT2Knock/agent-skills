import { createHmac } from "node:crypto"

export async function postHook(url: string, secret: string, body: string): Promise<Response> {
  const signature = createHmac("sha256", secret).update(body).digest("hex")
  return fetch(url, {
    method: "POST",
    headers: { "x-hub-signature": `sha256=${signature}`, "content-type": "application/json" },
    body,
  })
}

export async function kindOf(response: Response): Promise<string> {
  try {
    return ((await response.json()) as { kind?: string }).kind ?? "?"
  } catch {
    return "?"
  }
}
