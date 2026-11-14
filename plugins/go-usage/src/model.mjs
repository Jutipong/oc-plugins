// go-usage — view state -> the prompt-footer line.
//
// The prompt footer is a single narrow row, so the model renders one short
// `[H:92% · W:45% · M:44% | C:87% · ⚡103t/s]` line (H = rolling 5h, W =
// weekly, M = monthly, C = session cache hit) with per-field threshold tones
// and faint brackets/separators. The cache group (`C`) and the live speed
// group (`⚡`) are always present on the ready row when enabled, rendered
// compactly with no padding. Pure so the harness can assert every state.

import {
  displayWidth,
  formatCacheBadge,
  formatReset,
  formatTps,
  toneForCacheHit,
  toneForMeter,
  toneForTps,
  toNumber,
  truncate,
} from "./format.mjs"

const PROMPT_WIDTH = 40
const PROMPT_WIDTH_CACHE = 48

/** Footer meters in display order; the labels mirror the Console cards. */
export const STATUS_METERS = [
  { key: "rolling", prefix: "H" },
  { key: "weekly", prefix: "W" },
  { key: "monthly", prefix: "M" },
]

function seg(text, tone = "base") {
  return { text: String(text ?? ""), tone }
}

function lineWidth(line) {
  return (line ?? []).reduce((width, item) => width + displayWidth(item.text), 0)
}

function clipLine(line, width) {
  const output = []
  let remaining = width
  for (const item of line ?? []) {
    if (remaining <= 0) break
    const text = truncate(item.text, remaining)
    if (!text) continue
    output.push({ ...item, text })
    remaining -= displayWidth(text)
  }
  return output
}

const PHASE_LABELS = {
  checking: ["Go …", "muted"],
  loading: ["Go …", "muted"],
  disconnected: ["Go —", "warning"],
  absent: ["Go —", "warning"],
  error: ["Go !", "danger"],
}

/**
 * Join field groups with their own faint separators. Each group is a list of
 * segments so a label (`H:`) and its value (`92%`) can carry different tones;
 * `sep` is what precedes the group (`" · "` between meters, `" | "` before
 * the session fields).
 */
function groupsToLine(groups, count = groups.length) {
  const line = []
  groups.slice(0, count).forEach((group, index) => {
    if (index > 0) line.push(seg(group.sep ?? " · ", "faint"))
    line.push(...group.parts)
  })
  return line
}

/**
 * Bracket the fields, dropping trailing groups whole when the row is narrow.
 * `[` and `]` are always kept; if even one field overflows, the inside is
 * truncated but the closing bracket stays.
 */
function bracketLine(groups, budget) {
  for (let count = groups.length; count >= 1; count -= 1) {
    const line = [seg("[", "faint"), ...groupsToLine(groups, count), seg("]", "faint")]
    if (lineWidth(line) <= budget) return line
  }
  const inner = groupsToLine(groups)
  return [seg("[", "faint"), ...clipLine(inner, Math.max(0, budget - 2)), seg("]", "faint")]
}

/**
 * Pick the live speed for the session a footer is rendering. The tracker
 * publishes one value per session; a footer only shows its own session.
 */
export function speedForSession(speeds, sessionID) {
  if (!speeds || !sessionID) return null
  const value = toNumber(speeds[sessionID])
  return value != null && value > 0 ? value : null
}

/**
 * Pick the cache stats for the session a footer is rendering. `null` means
 * "cache field is on but this session has no counters yet".
 */
export function cacheForSession(caches, sessionID) {
  if (!caches || !sessionID) return null
  const entry = caches[sessionID]
  return entry && typeof entry === "object" ? entry : null
}

/** `C:87%` — this session's cache hit. */
function cacheGroup(cache) {
  const percent = toNumber(cache?.percent)
  return {
    sep: " | ",
    parts: [
      seg("C:", "muted"),
      seg(formatCacheBadge(percent), percent == null ? "muted" : toneForCacheHit(percent)),
    ],
  }
}

/** `⚡103t/s` — the live output speed of this session. */
function speedGroup(speed) {
  const value = toNumber(speed)
  const shown = value != null && value > 0 ? value : 0
  return {
    sep: " · ",
    parts: [
      seg("⚡", "muted"),
      seg(formatTps(shown), shown > 0 ? toneForTps(shown) : "muted"),
      seg("t/s", "muted"),
    ],
  }
}

/**
 * `prompt.footer.status` line.
 *
 * view: { phase, status, stale, error, fetchedAt, speed, cache }
 *   phase: "checking" | "loading" | "ready" | "error" | "absent" | "disconnected"
 *   speed: live tokens/second while this session is generating, else null
 *   cache: `{ percent }` for this session, `null` when it has no counters yet,
 *          or `undefined` when the cache field is disabled
 *
 * options:
 *   width — max cells (default 48 with the cache field, 40 without)
 */
export function buildPromptLine(view = {}, options = {}) {
  const phase = view.phase ?? "checking"
  const cacheEnabled = view.cache !== undefined
  const width = Math.max(8, Math.round(options.width ?? (cacheEnabled ? PROMPT_WIDTH_CACHE : PROMPT_WIDTH)))

  if (phase === "ready" && view.status) {
    const meters = new Map((view.status.meters ?? []).map((entry) => [entry.key, entry.meter]))
    const groups = STATUS_METERS.map(({ key, prefix }) => {
      const meter = meters.get(key)
      return {
        parts: meter
          ? [seg(`${prefix}:`, "muted"), seg(meter.badge, toneForMeter(meter.percent))]
          : [seg(`${prefix}:`, "muted"), seg("—", "muted")],
      }
    })
    if (cacheEnabled) groups.push(cacheGroup(view.cache))
    groups.push(speedGroup(view.speed))
    const prefix = view.stale ? [seg("! ", "warning")] : []
    const budget = Math.max(0, width - lineWidth(prefix))
    return [...prefix, ...bracketLine(groups, budget)]
  }

  const [text, tone] = PHASE_LABELS[phase] ?? PHASE_LABELS.checking
  return clipLine([seg(text, tone)], width)
}

/** Plain-text body for the `/go-usage` detail dialog. */
export function buildDetailLines(view = {}) {
  const now = view.now ?? Date.now()
  const phase = view.phase ?? "checking"
  if (phase === "checking") {
    return ["Not connected to OpenCode Go.", "", "Run /go-usage and approve the code in your browser."]
  }
  if (phase === "loading") return ["Checking your OpenCode Go usage…"]
  if (phase === "disconnected") {
    return ["Your OpenCode Console session has expired.", "", "Run /go-usage again to reconnect."]
  }
  if (phase === "absent") {
    return [
      "No active OpenCode Go subscription was found for this Console account.",
      "",
      "Subscribe or manage your plan at https://opencode.ai/console",
    ]
  }
  if (phase === "error") {
    return [
      "Could not fetch your OpenCode Go usage.",
      view.error ? `Last error: ${view.error}` : null,
      "",
      "The prompt footer keeps retrying automatically.",
    ].filter((line) => line !== null)
  }

  const status = view.status
  if (!status) return ["No usage data yet."]
  const lines = [`Plan: ${status.plan}`]
  for (const entry of status.meters ?? []) {
    const meter = entry.meter
    if (!meter) {
      lines.push(`${entry.label}: no data`)
      continue
    }
    const reset = formatReset(meter.resetsAt, now)
    lines.push(`${entry.label}: ${meter.badge}${reset ? ` · resets in ${reset}` : ""}`)
  }
  if (view.stale) lines.push("", "Showing the last known values — the latest refresh failed.")
  return lines
}
