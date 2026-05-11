import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getOptionalServerEnv } from "@/lib/env"
import {
  ADMIN_COOKIE,
  constantTimeEqual,
  signAdminJwt,
  verifyAdminPassword,
} from "@/lib/auth"
import { readJsonBody } from "@/lib/safe-body"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"

// 5 attempts per 15 minutes per IP ??? brute-force protection.
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_MAX = 5

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  const rl = checkRateLimit(`admin-login:${ip}`, LOGIN_MAX, LOGIN_WINDOW_MS)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs)

  let body: { username?: string; password?: string }
  const parsed = await readJsonBody<{ username?: string; password?: string }>(request)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  }
  body = parsed.body

  const { username, password } = body
  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 })
  }
  if (password.length > 512) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  const env = getOptionalServerEnv()
  if (!env.adminUsername || !env.adminPassword || !env.jwtSecret) {
    return NextResponse.json({ error: "Admin not configured" }, { status: 503 })
  }

  // Verify both sides — both checks always run so timing doesn't reveal
  // which one failed.
  const userOk = constantTimeEqual(username, env.adminUsername)
  const passOk = verifyAdminPassword(password, env.adminPassword)
  if (!userOk || !passOk) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  const token = await signAdminJwt(env.adminUsername)
  const cookieStore = await cookies()
  cookieStore.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 8, // 8h ??? matches JWT exp
    path: "/",
  })

  return NextResponse.json({ ok: true })
}

export async function DELETE() {
  const cookieStore = await cookies()
  cookieStore.delete(ADMIN_COOKIE)
  return NextResponse.json({ ok: true })
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}
