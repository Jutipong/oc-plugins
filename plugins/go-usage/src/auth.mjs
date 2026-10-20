// go-usage — OpenCode Console account device login.
//
// Mirrors the OpenCode CLI's "OpenCode Console account" integration: an OAuth
// 2.0 device flow against the Console (client_id "opencode-cli"), then Bearer
// requests to the Console API. Request/response handling is pure so the
// harness can drive it with a mock fetch. API keys (sk-... from auth.json) do
// NOT work on the Console API.

import { toNumber } from "./format.mjs"

export const CLIENT_ID = "opencode-cli"
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const DEFAULT_BASE_URL = "https://opencode.ai/console"
export const REFRESH_SKEW_MS = 60_000
const DEFAULT_TOKEN_LIFETIME_MS = 3_600_000
const DEFAULT_POLL_MS = 5_000
const DEFAULT_EXPIRES_MS = 600_000
const SLOW_DOWN_STEP_MS = 5_000

export function normalizeBaseUrl(value, fallback = DEFAULT_BASE_URL) {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback
  return text.replace(/\/+$/, "")
}

function jsonInit(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  }
}

export function buildDeviceCodeRequest(baseUrl) {
  return {
    url: `${normalizeBaseUrl(baseUrl)}/auth/device/code`,
    init: jsonInit({ client_id: CLIENT_ID, supports_org_scope: true }),
  }
}

export function buildTokenPollRequest(baseUrl, deviceCode) {
  return {
    url: `${normalizeBaseUrl(baseUrl)}/auth/device/token`,
    init: jsonInit({ grant_type: DEVICE_GRANT, device_code: String(deviceCode ?? ""), client_id: CLIENT_ID }),
  }
}

export function buildRefreshRequest(baseUrl, refreshToken) {
  return {
    url: `${normalizeBaseUrl(baseUrl)}/auth/device/token`,
    init: jsonInit({ grant_type: "refresh_token", refresh_token: String(refreshToken ?? ""), client_id: CLIENT_ID }),
  }
}

/** `GET /api/go/status` — the console route the CLI-facing API uses. */
export function buildStatusRequest(baseUrl, accessToken, orgId) {
  const headers = { accept: "application/json", authorization: `Bearer ${accessToken}` }
  if (orgId) headers["x-org-id"] = String(orgId)
  return { url: `${normalizeBaseUrl(baseUrl)}/api/go/status`, init: { method: "GET", headers } }
}

/** Resolve a possibly-relative verification URL against the console base. */
export function absoluteUrl(value, baseUrl) {
  if (typeof value !== "string" || !value) return null
  try {
    return new URL(value, `${normalizeBaseUrl(baseUrl)}/`).href
  } catch {
    return null
  }
}

/** Device-code response -> { deviceCode, userCode, url, expiresInMs, intervalMs }. */
export function parseDeviceCode(json, baseUrl) {
  const body = json && typeof json === "object" ? json : {}
  const deviceCode = typeof body.device_code === "string" ? body.device_code : null
  const userCode = typeof body.user_code === "string" ? body.user_code : null
  const url = absoluteUrl(body.verification_uri_complete ?? body.verification_uri, baseUrl)
  if (!deviceCode || !userCode || !url) return null
  const expiresInMs = Math.max(30_000, Math.round((toNumber(body.expires_in) ?? DEFAULT_EXPIRES_MS / 1000) * 1000))
  const intervalMs = Math.max(1_000, Math.round((toNumber(body.interval) ?? DEFAULT_POLL_MS / 1000) * 1000))
  return { deviceCode, userCode, url, expiresInMs, intervalMs }
}

/** Token endpoint JSON -> stored auth document. */
export function tokensFromJson(json, now = Date.now()) {
  const body = json && typeof json === "object" ? json : {}
  const expiresInSec = toNumber(body.expires_in)
  const lifetime = expiresInSec != null && expiresInSec > 0 ? expiresInSec * 1000 : DEFAULT_TOKEN_LIFETIME_MS
  return {
    access: typeof body.access_token === "string" ? body.access_token : null,
    refresh: typeof body.refresh_token === "string" ? body.refresh_token : null,
    orgId: body.org_id != null ? String(body.org_id) : null,
    expiresAt: (toNumber(now) ?? Date.now()) + lifetime,
  }
}

/** Token endpoint (status, json) -> outcome discriminant. */
export function parseTokenOutcome(status, json, now = Date.now()) {
  const code = toNumber(status) ?? 0
  const body = json && typeof json === "object" ? json : {}
  if (code >= 200 && code < 300 && typeof body.access_token === "string") {
    return { kind: "ok", tokens: tokensFromJson(body, now) }
  }
  const error = typeof body.error === "string" ? body.error : null
  switch (error) {
    case "authorization_pending":
      return { kind: "pending" }
    case "slow_down":
      return { kind: "slow-down" }
    case "expired_token":
      return { kind: "expired" }
    case "access_denied":
      return { kind: "denied", error }
    case "invalid_grant":
      return { kind: "invalid", error }
    default:
      return { kind: "error", status: code || null, error }
  }
}

/** Should the access token be refreshed before the next request? */
export function needsRefresh(auth, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!auth) return false
  const refresh = typeof auth.refresh === "string" && auth.refresh ? auth.refresh : null
  const access = typeof auth.access === "string" && auth.access ? auth.access : null
  if (!access) return Boolean(refresh)
  const expiresAt = toNumber(auth.expiresAt)
  if (expiresAt == null) return false
  return expiresAt - skewMs <= (toNumber(now) ?? Date.now())
}

/** fetch + JSON with the plugin user agent. Never throws on non-JSON bodies. */
export async function fetchJson(fetchImpl, request, userAgent) {
  const headers = { ...request.init.headers }
  if (userAgent) headers["user-agent"] = userAgent
  const response = await fetchImpl(request.url, { ...request.init, headers })
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: toNumber(response.status) ?? 0, json }
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Stateful auth helper. `persist(next)` is called with the new auth document
 * (or null) so the caller can mirror it into durable plugin storage.
 */
export function createAuthManager({
  fetchImpl,
  baseUrl = DEFAULT_BASE_URL,
  userAgent,
  now = Date.now,
  delay = defaultDelay,
  initial = null,
  persist,
} = {}) {
  let auth = null
  if (initial && (initial.access || initial.refresh)) {
    auth = {
      access: typeof initial.access === "string" ? initial.access : null,
      refresh: typeof initial.refresh === "string" ? initial.refresh : null,
      orgId: initial.orgId != null ? String(initial.orgId) : null,
      expiresAt: toNumber(initial.expiresAt) ?? 0,
    }
  }

  function store(next) {
    auth = next
    if (typeof persist === "function") {
      try {
        persist(next)
      } catch {
        // Persistence must never break the login flow.
      }
    }
    return auth
  }

  function mergeOrg(next) {
    return { ...next, orgId: next.orgId ?? auth?.orgId ?? null }
  }

  const manager = {
    get auth() {
      return auth
    },
    get connected() {
      return Boolean(auth && (auth.access || auth.refresh))
    },
    /** Pick up tokens that were hydrated from durable storage after setup. */
    adopt(initial) {
      if (auth || !initial || (!initial.access && !initial.refresh)) return auth
      return store({
        access: typeof initial.access === "string" ? initial.access : null,
        refresh: typeof initial.refresh === "string" ? initial.refresh : null,
        orgId: initial.orgId != null ? String(initial.orgId) : null,
        expiresAt: toNumber(initial.expiresAt) ?? 0,
      })
    },
    async beginLogin() {
      const response = await fetchJson(fetchImpl, buildDeviceCodeRequest(baseUrl), userAgent)
      if (response.status < 200 || response.status >= 300) return { kind: "error", status: response.status }
      const flow = parseDeviceCode(response.json, baseUrl)
      if (!flow) return { kind: "error", status: response.status }
      return { kind: "ok", flow }
    },
    /** Poll until approved / expired / cancelled. */
    async completeLogin(flow, { shouldCancel, onTick } = {}) {
      if (!flow) return { kind: "error" }
      let waitMs = flow.intervalMs
      const deadline = now() + flow.expiresInMs
      while (now() < deadline) {
        await delay(waitMs)
        if (typeof shouldCancel === "function" && shouldCancel()) return { kind: "cancelled" }
        const response = await fetchJson(fetchImpl, buildTokenPollRequest(baseUrl, flow.deviceCode), userAgent)
        const outcome = parseTokenOutcome(response.status, response.json, now())
        if (outcome.kind === "ok") {
          return { kind: "ok", tokens: store(mergeOrg(outcome.tokens)), flow }
        }
        if (outcome.kind === "pending") {
          try {
            onTick?.()
          } catch {
            // progress callbacks are best-effort
          }
          continue
        }
        if (outcome.kind === "slow-down") {
          waitMs += SLOW_DOWN_STEP_MS
          continue
        }
        return outcome
      }
      return { kind: "expired" }
    },
    async refresh() {
      if (!auth?.refresh) return null
      const response = await fetchJson(fetchImpl, buildRefreshRequest(baseUrl, auth.refresh), userAgent)
      const outcome = parseTokenOutcome(response.status, response.json, now())
      if (outcome.kind !== "ok") return null
      return store(mergeOrg(outcome.tokens))
    },
    async accessToken() {
      if (!auth) return null
      if (needsRefresh(auth, now())) await manager.refresh()
      return auth?.access ?? null
    },
    logout() {
      store(null)
    },
  }
  return manager
}
