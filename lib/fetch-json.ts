/**
 * Defensive JSON fetcher used by all client components that hit our APIs.
 *
 * Reasons a `res.json()` call can throw a confusing "Unexpected token '<'":
 *   - dev server not running / turbopack hasn't picked up a new route → 404 HTML
 *   - ngrok interstitial warning page
 *   - upstream proxy error page (502/503 HTML)
 *   - a runtime error before the route handler ran (Next.js error overlay HTML)
 *
 * Instead of letting `res.json()` blow up with a parser error, this helper
 * surfaces a precise, debuggable message: HTTP status + content-type + a body
 * preview.
 */
export class FetchJsonError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly contentType: string,
    public readonly bodyPreview?: string,
  ) {
    super(message)
    this.name = "FetchJsonError"
  }
}

export async function fetchJson<T = unknown>(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, init)
  const ct = res.headers.get("content-type") ?? ""

  if (!ct.toLowerCase().includes("application/json")) {
    const preview = await safePreview(res)
    throw new FetchJsonError(
      `Expected JSON from ${urlOf(input)}, got ${ct || "no content-type"} (status ${res.status})`,
      res.status,
      ct,
      preview,
    )
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (e) {
    throw new FetchJsonError(
      `Invalid JSON from ${urlOf(input)} (status ${res.status})`,
      res.status,
      ct,
      e instanceof Error ? e.message : String(e),
    )
  }

  if (!res.ok) {
    const errMsg =
      (data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : null) ?? `HTTP ${res.status} from ${urlOf(input)}`
    throw new FetchJsonError(errMsg, res.status, ct)
  }

  return data as T
}

async function safePreview(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text()
    return text.length > 200 ? text.slice(0, 200) + "…" : text
  } catch {
    return undefined
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}
