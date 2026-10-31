// go-usage — view state -> the prompt-footer line.
//
// The prompt footer is a single narrow row, so the model renders one short
// `[H:92% · W:45% · M:44%]` line (H = rolling 5h, W = weekly, M = monthly)
// with per-meter threshold tones and faint brackets/separators. A trailing
// `⚡45 tok/s` field always shows the live rate in the ready row (`⚡0 tok/s`,
// muted, while the session is idle), toned green/amber/red by speed. Pure so
// the harness can assert every state.

import { displayWidth, formatReset, formatTps, toneForMeter, toneForTps, toNumber, truncate } from "./format.mjs"

const PROMPT_WIDTH = 40

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
 * Join meter groups with faint ` · ` separators. Each group is a list of
 * segments so the label (`H:`) and the value (`92%`) can carry different tones.
 */
function meterSegments(meters) {
  const line = []
  meters.forEach((parts, index) => {
    if (index > 0) line.push(seg(" · ", "faint"))
    line.push(...parts)
  })
  return line
}

/**
 * Bracket the meters, dropping trailing buckets whole when the row is narrow.
 * `[` and `]` are always kept; if even one meter overflows, the inside is
 * truncated but the closing bracket stays.
 */
function bracketLine(meters, budget) {
  for (let count = meters.length; count >= 1; count -= 1) {
    const line = [seg("[", "faint"), ...meterSegments(meters.slice(0, count)), seg("]", "faint")]
    if (lineWidth(line) <= budget) return line
  }
  const inner = meterSegments(meters)
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
 * `prompt.footer.status` line.
 *
 * view: { phase, status, stale, error, fetchedAt, speed }
 *   phase: "checking" | "loading" | "ready" | "error" | "absent" | "disconnected"
 *   speed: live tokens/second while this session is generating, else null
 *
 * options:
 *   width — max cells (default 40)
 */
export function buildPromptLine(view = {}, options = {}) {
  const width = Math.max(8, Math.round(options.width ?? PROMPT_WIDTH))
  const phase = view.phase ?? "checking"

  if (phase === "ready" && view.status) {
    const meters = new Map((view.status.meters ?? []).map((entry) => [entry.key, entry.meter]))
    const groups = STATUS_METERS.map(({ key, prefix }) => {
      const meter = meters.get(key)
      return meter
        ? [seg(`${prefix}:`, "muted"), seg(meter.badge, toneForMeter(meter.percent))]
        : [seg(`${prefix}:`, "muted"), seg("—", "muted")]
    })
    const speed = toNumber(view.speed) ?? 0
    groups.push([
      seg("⚡", "muted"),
      seg(formatTps(speed), speed > 0 ? toneForTps(speed) : "muted"),
      seg(" tok/s", "muted"),
    ])
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
