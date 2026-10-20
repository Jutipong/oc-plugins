// go-usage — console payload -> normalized meters.
//
// The console SPA (opencode.ai/console) renders Go meters from
// `GET /console/api/go/status`. The payload is nullable (no subscription) and
// meter amounts are micro-cents (1e8 per dollar), usually encoded as strings
// for bigint safety.

import { toNumber, toTime } from "./format.mjs"

/** Console meter keys, in prompt-footer order (H / W / M). */
export const METER_KEYS = [
  { key: "rolling", label: "Rolling", source: "fiveHour" },
  { key: "weekly", label: "Weekly", source: "week" },
  { key: "monthly", label: "Monthly", source: "month" },
]

const PLAN_LABELS = { go: "Go", "go-plus": "Go Plus" }

/**
 * One meter -> { used, limit, percent, badge, exhausted, resetsAt, startsAt }.
 * Mirrors the console: integer percent, ">99%" when rounding to 100 while not
 * actually exhausted, and "100%" when used >= limit.
 */
export function meterFromRaw(raw) {
  if (!raw || typeof raw !== "object") return null
  const used = toNumber(raw.usedMicroCents)
  const limit = toNumber(raw.limitMicroCents)
  if (used == null || limit == null || limit <= 0) return null
  const exhausted = used >= limit
  const percent = exhausted ? 100 : Math.round((used / limit) * 100)
  const badge = exhausted ? "100%" : percent === 100 ? ">99%" : `${percent}%`
  return {
    used,
    limit,
    percent,
    badge,
    exhausted,
    resetsAt: toTime(raw.resetsAt),
    startsAt: toTime(raw.startsAt),
  }
}

/** Full `go/status` payload -> the shape the footer/dialog render. */
export function normalizeStatus(payload, now = Date.now()) {
  if (payload == null || typeof payload !== "object") {
    return {
      present: false,
      product: null,
      plan: null,
      hasAccess: false,
      meters: [],
      fetchedAt: toNumber(now) ?? Date.now(),
    }
  }
  const product = typeof payload.product === "string" ? payload.product : null
  const access = payload.access && typeof payload.access === "object" ? payload.access : null
  const rawMeters = access?.meters && typeof access.meters === "object" ? access.meters : {}
  return {
    present: true,
    product,
    plan: PLAN_LABELS[product] ?? "OpenCode Go",
    hasAccess: Boolean(access),
    meters: METER_KEYS.map(({ key, label, source }) => ({
      key,
      label,
      meter: meterFromRaw(rawMeters[source]),
    })),
    fetchedAt: toNumber(now) ?? Date.now(),
  }
}
