// go-usage — Console usage fetch with refresh-on-401.
//
// Thin layer over the auth manager: one GET, retried once after a silent token
// refresh. All outcomes are data (never thrown) so the footer can keep
// rendering the last known values.

import { DEFAULT_BASE_URL, buildStatusRequest, fetchJson, normalizeBaseUrl } from "./auth.mjs"

export function createUsageService({ fetchImpl, baseUrl = DEFAULT_BASE_URL, userAgent, auth, orgId = null } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  // An explicit org (option/env) wins over the org stored with the token.
  const request = (token, scopedOrg) => fetchJson(fetchImpl, buildStatusRequest(base, token, orgId ?? scopedOrg), userAgent)

  return {
    async fetchStatus() {
      try {
        if (!auth?.connected) return { kind: "disconnected" }
        const token = await auth.accessToken()
        if (!token) return { kind: "unauthorized" }
        let response = await request(token, auth.auth?.orgId)
        if (response.status === 401 || response.status === 403) {
          const refreshed = await auth.refresh()
          if (!refreshed?.access) return { kind: "unauthorized", status: response.status }
          response = await request(refreshed.access, refreshed.orgId)
        }
        const status = response.status
        if (status < 200 || status >= 300) return { kind: "error", status, message: `HTTP ${status}` }
        if (response.json == null) return { kind: "absent" }
        return { kind: "ok", payload: response.json }
      } catch (error) {
        return { kind: "error", status: null, message: error?.message ?? "network error" }
      }
    },
  }
}
