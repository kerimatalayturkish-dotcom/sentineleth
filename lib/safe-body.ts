/**
 * Cap on request body size for JSON POSTs.
 *
 * Next's `request.json()` will read the entire body into memory before
 * parsing. We set Content-Length and an explicit byte cap so a malicious
 * client can't OOM the server with a multi-MB JSON payload.
 *
 * 8 KiB is comfortably more than every legitimate body in this app
 * (admin actions are small JSON objects, the largest is `setAirdropRoot`
 * which is < 200 bytes).
 */
export const MAX_JSON_BODY_BYTES = 8 * 1024

export type SafeBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; error: string }

/**
 * Reads + JSON-parses a request body with a hard size cap.
 *
 * Order of checks:
 *   1. Content-Length header (trust but verify) — reject early.
 *   2. After read, re-measure the actual decoded length and reject if
 *      the client lied about Content-Length.
 *   3. JSON.parse — caller-typed.
 *
 * Always returns a discriminated result rather than throwing, so route
 * handlers stay flat.
 */
export async function readJsonBody<T>(request: Request): Promise<SafeBodyResult<T>> {
  const cl = request.headers.get("content-length")
  if (cl) {
    const n = Number(cl)
    if (Number.isFinite(n) && n > MAX_JSON_BODY_BYTES) {
      return { ok: false, status: 413, error: "Request body too large" }
    }
  }

  // Read as text first so we can measure post-decode size.
  let text: string
  try {
    text = await request.text()
  } catch {
    return { ok: false, status: 400, error: "Failed to read request body" }
  }
  if (text.length > MAX_JSON_BODY_BYTES) {
    return { ok: false, status: 413, error: "Request body too large" }
  }
  if (text.length === 0) {
    return { ok: false, status: 400, error: "Empty request body" }
  }

  try {
    return { ok: true, body: JSON.parse(text) as T }
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" }
  }
}
