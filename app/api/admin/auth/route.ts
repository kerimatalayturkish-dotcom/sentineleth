import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getOptionalServerEnv } from "@/lib/env"
import {
  ADMIN_COOKIE,
  ADMIN_PENDING_2FA_COOKIE,
  constantTimeEqual,
  signAdminJwt,
  signPendingAdminTotpJwt,
  verifyAdminPassword,
  verifyAdminTotp,
  verifyPendingAdminTotpJwt,
} from "@/lib/auth"
import { readJsonBody } from "@/lib/safe-body"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"

type AdminAuthBody = {
  username?: string
  password?: string
  totpCode?: string
}

type OptionalAdminEnv = ReturnType<typeof getOptionalServerEnv>
type ReadyAdminEnv = OptionalAdminEnv & {
  adminUsername: string
  jwtSecret: string
}

// 5 password attempts per 15 minutes per IP.
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_MAX = 5
// TOTP is the second factor after a correct password, so allow a few extra
// retries for device clock skew or simple typing mistakes.
const TOTP_MAX = 10

function setSessionCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, token: string) {
  cookieStore.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 8,
    path: "/",
  })
}

function setPendingTotpCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, token: string) {
  cookieStore.set(ADMIN_PENDING_2FA_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 5,
    path: "/",
  })
}

function clearAuthCookies(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  cookieStore.delete(ADMIN_COOKIE)
  cookieStore.delete(ADMIN_PENDING_2FA_COOKIE)
}

function adminTotpConfigured(secret?: string): secret is string {
  return typeof secret === "string" && secret.length > 0
}

function invalidTotpConfiguration() {
  return NextResponse.json({ error: "Admin 2FA is misconfigured" }, { status: 503 })
}

function hasReadyAdminEnv(env: OptionalAdminEnv): env is ReadyAdminEnv {
  return Boolean(env.adminUsername && (env.adminPassword || env.adminPasswordHash) && env.jwtSecret)
}

async function finishTotpLogin(
  body: AdminAuthBody,
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  env: ReadyAdminEnv,
) {
  if (!adminTotpConfigured(env.adminTotpSecret)) {
    clearAuthCookies(cookieStore)
    return NextResponse.json({ error: "Admin 2FA is not configured", resetTotpStep: true }, { status: 400 })
  }

  const code = typeof body.totpCode === "string" ? body.totpCode : ""
  if (!code) {
    return NextResponse.json({ error: "Missing authentication code" }, { status: 400 })
  }

  const pendingToken = cookieStore.get(ADMIN_PENDING_2FA_COOKIE)?.value
  const subject = pendingToken ? await verifyPendingAdminTotpJwt(pendingToken) : null
  if (!subject || subject !== env.adminUsername) {
    clearAuthCookies(cookieStore)
    return NextResponse.json({ error: "Password step expired. Log in again.", resetTotpStep: true }, { status: 401 })
  }

  let totpOk = false
  try {
    totpOk = verifyAdminTotp(code, env.adminTotpSecret)
  } catch {
    clearAuthCookies(cookieStore)
    return invalidTotpConfiguration()
  }

  if (!totpOk) {
    return NextResponse.json({ error: "Invalid authentication code" }, { status: 401 })
  }

  clearAuthCookies(cookieStore)
  const token = await signAdminJwt(subject)
  setSessionCookie(cookieStore, token)
  return NextResponse.json({ ok: true })
}

async function startCredentialLogin(
  body: AdminAuthBody,
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  env: ReadyAdminEnv,
) {
  const { username, password, totpCode } = body
  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 })
  }
  if (password.length > 512) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  const userOk = constantTimeEqual(username, env.adminUsername)
  const passOk = await verifyAdminPassword(password, {
    hash: env.adminPasswordHash,
    plaintext: env.adminPassword,
  })
  if (!userOk || !passOk) {
    clearAuthCookies(cookieStore)
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  if (!adminTotpConfigured(env.adminTotpSecret)) {
    clearAuthCookies(cookieStore)
    const token = await signAdminJwt(env.adminUsername)
    setSessionCookie(cookieStore, token)
    return NextResponse.json({ ok: true })
  }

  if (typeof totpCode === "string" && totpCode.trim()) {
    let totpOk = false
    try {
      totpOk = verifyAdminTotp(totpCode, env.adminTotpSecret)
    } catch {
      clearAuthCookies(cookieStore)
      return invalidTotpConfiguration()
    }

    if (!totpOk) {
      return NextResponse.json({ error: "Invalid authentication code" }, { status: 401 })
    }

    clearAuthCookies(cookieStore)
    const token = await signAdminJwt(env.adminUsername)
    setSessionCookie(cookieStore, token)
    return NextResponse.json({ ok: true })
  }

  const pendingToken = await signPendingAdminTotpJwt(env.adminUsername)
  setPendingTotpCookie(cookieStore, pendingToken)
  return NextResponse.json({ ok: true, requiresTotp: true })
}

export async function POST(request: NextRequest) {
  const parsed = await readJsonBody<AdminAuthBody>(request)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  }
  const body = parsed.body

  const ip = getClientIp(request)
  const totpOnlyStep = typeof body.totpCode === "string" && !body.username && !body.password
  const rl = checkRateLimit(
    `${totpOnlyStep ? "admin-login-totp" : "admin-login"}:${ip}`,
    totpOnlyStep ? TOTP_MAX : LOGIN_MAX,
    LOGIN_WINDOW_MS,
  )
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs)

  const env = getOptionalServerEnv()
  if (!hasReadyAdminEnv(env)) {
    return NextResponse.json({ error: "Admin not configured" }, { status: 503 })
  }

  const cookieStore = await cookies()
  if (totpOnlyStep) {
    return finishTotpLogin(body, cookieStore, env)
  }

  return startCredentialLogin(body, cookieStore, env)
}

export async function DELETE() {
  const cookieStore = await cookies()
  clearAuthCookies(cookieStore)
  return NextResponse.json({ ok: true })
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}
