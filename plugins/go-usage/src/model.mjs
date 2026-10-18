// go-usage — view state -> render model.
//
// Pure functions that turn the plugin's view state into lines of styled
// segments (sidebar) and plain lines (detail dialog). The JSX layer only maps
// segment tones to theme tokens, so the exact text is fully testable without
// OpenTUI.

import {
  bar,
  displayWidth,
  formatAge,
  formatClock,
  formatMoney,
  formatReset,
  toneForMeter,
  truncate,
} from "./format.mjs"

const DEFAULT_WIDTH = 36
// Border styles drawn by the model: rounded `╭─╮│╰╯`, heavy `┏━┓┃┗┛`.
const FRAME_CHARS = {
  rounded: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
  heavy: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", horizontal: "━", vertical: "┃" },
}

function seg(text, tone = "base", bold = false) {
  return { text: String(text ?? ""), tone, bold }
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

function clipAll(lines, width) {
  return lines.map((line) => clipLine(line, width))
}

/** Left content, right-aligned content, one `width`-cell row. */
function alignLine(left, right, width) {
  const leftWidth = lineWidth(left)
  const rightWidth = lineWidth(right)
  const pad = Math.max(1, width - leftWidth - rightWidth)
  return clipLine([...left, seg(" ".repeat(pad)), ...right], width)
}

function headerLine(view, width) {
  const left = [seg("◈ Go usage", "accent", true)]
  const right = view.status?.plan ? [seg(view.status.plan, "muted")] : []
  return alignLine(left, right, width)
}

/** sys-status-compatible bar rendering: `mole` = toned track, `solid` = blank remainder. */
function barSegments(shape, tone, barStyle) {
  if (barStyle === "solid") {
    return [seg(shape.filled, tone), seg(" ".repeat(Math.max(0, shape.width - displayWidth(shape.filled))), "faint")]
  }
  return [seg(shape.filled, tone), seg(shape.empty, tone)]
}

function meterLines(status, width, now, barStyle) {
  const lines = []
  for (const entry of status.meters ?? []) {
    const meter = entry.meter
    if (!meter) {
      lines.push(alignLine([seg(entry.label, "base")], [seg("no data", "muted")], width))
      continue
    }
    const tone = toneForMeter(meter.percent)
    const reset = formatReset(meter.resetsAt, now)
    const right = [seg(meter.badge, tone, true), ...(reset ? [seg(` · ${reset}`, "muted")] : [])]
    lines.push(alignLine([seg(entry.label, "base")], right, width))
    lines.push(barSegments(bar(meter.percent, width), tone, barStyle))
  }
  return lines
}

function footerLine(view, width) {
  return [seg(truncate("stale · retrying automatically", width), "warning")]
}

/** Border row: `╭─ ◈ Go usage ────────── 22:31:05 ─╮` (time = last fetch). */
function frameTop(view, total, chars) {
  const left = [
    seg(`${chars.topLeft}${chars.horizontal} `, "border"),
    seg("◈ Go usage", "accent", true),
    seg(" ", "border"),
  ]
  const time = view.fetchedAt ? formatClock(view.fetchedAt) : null
  if (!time) {
    const dashes = Math.max(1, total - lineWidth(left) - 1)
    return clipLine([...left, seg(`${chars.horizontal.repeat(dashes)}${chars.topRight}`, "border")], total)
  }
  const right = [seg(" ", "border"), seg(time, view.stale ? "warning" : "muted"), seg(` ${chars.horizontal}${chars.topRight}`, "border")]
  const dashes = Math.max(1, total - lineWidth(left) - lineWidth(right))
  return clipLine([...left, seg(chars.horizontal.repeat(dashes), "border"), ...right], total)
}

function frameBottom(total, chars) {
  return [seg(`${chars.bottomLeft}${chars.horizontal.repeat(Math.max(0, total - 2))}${chars.bottomRight}`, "border")]
}

/** Pad a content line to exactly `width` cells so the right border aligns. */
function padLine(line, width) {
  const clipped = clipLine(line, width)
  const missing = width - lineWidth(clipped)
  if (missing <= 0) return clipped
  return [...clipped, seg(" ".repeat(missing), "base")]
}

function frameContentLine(line, inner, chars) {
  return [seg(`${chars.vertical} `, "border"), ...padLine(line, inner), seg(` ${chars.vertical}`, "border")]
}

/**
 * `sidebar.content` block.
 *
 * view: { phase, status, stale, error, fetchedAt }
 *   phase: "checking" | "loading" | "ready" | "error" | "absent" | "disconnected"
 *
 * options:
 *   width    — total cells (default 36)
 *   frame    — "none" (default) | "rounded" | "heavy"; framed layouts put
 *              "◈ Go usage" top-left and the last fetch clock top-right
 *   header   — force the in-content header line on/off (default: off when framed)
 *   barStyle — "mole" (default: `█` fill + `░` track, both in the threshold
 *              color, like sys-status) | "solid" (fill only, faint remainder)
 */
export function buildSidebarModel(view = {}, options = {}) {
  const total = Math.max(16, Math.round(options.width ?? DEFAULT_WIDTH))
  const frame = options.frame === "rounded" || options.frame === "heavy" ? options.frame : "none"
  const framed = frame !== "none"
  const width = framed ? Math.max(12, total - 4) : total
  const barStyle = options.barStyle === "solid" ? "solid" : "mole"
  const now = view.now ?? Date.now()
  const phase = view.phase ?? "checking"
  const showHeader = options.header ?? !framed
  const lines = showHeader ? [headerLine(view, width)] : []

  if (phase === "ready" && view.status) {
    lines.push(...meterLines(view.status, width, now, barStyle))
    // The footer only exists when there is something to warn about.
    if (view.stale) lines.push(footerLine(view, width))
  } else {
    const body = {
      checking: [
        [seg("not connected", "muted")],
        [seg(truncate("/go-usage to connect", width), "faint")],
      ],
      loading: [[seg("checking usage…", "muted")]],
      disconnected: [
        [seg("session expired", "warning")],
        [seg(truncate("/go-usage to reconnect", width), "faint")],
      ],
      absent: [
        [seg("no active Go subscription", "warning")],
        [seg(truncate("/go-usage for details", width), "faint")],
      ],
      error: [
        [seg(truncate(view.error ? `fetch failed · ${view.error}` : "fetch failed", width), "warning")],
        [seg(truncate("retrying automatically", width), "faint")],
      ],
    }[phase] ?? [[seg("checking usage…", "muted")]]
    lines.push(...body)
  }

  if (!framed) return { lines: clipAll(lines, width) }

  const chars = FRAME_CHARS[frame]
  return {
    lines: [
      frameTop(view, total, chars),
      ...lines.map((line) => frameContentLine(line, width, chars)),
      frameBottom(total, chars),
    ],
  }
}

/** Plain-text body for the `/go-usage` detail dialog. */
export function buildDetailLines(view = {}) {
  const now = view.now ?? Date.now()
  const phase = view.phase ?? "checking"
  if (phase === "checking") {
    return [
      "Not connected to OpenCode Go.",
      "",
      "Run /go-usage and approve the code in your browser.",
    ]
  }
  if (phase === "loading") return ["Checking your OpenCode Go usage…"]
  if (phase === "disconnected") {
    return [
      "Your OpenCode Console session has expired.",
      "",
      "Run /go-usage again to reconnect.",
    ]
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
      "The sidebar keeps retrying automatically.",
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
    lines.push(`${entry.label}: ${meter.badge}`)
    lines.push(`  ${formatMoney(meter.used)} of ${formatMoney(meter.limit)}${reset ? ` · resets in ${reset}` : ""}`)
  }
  if (status.useBalance) lines.push("", "Extra usage falls back to your Console balance after limits.")
  if (view.stale) lines.push("", "Showing the last known values — the latest refresh failed.")
  const age = formatAge(view.fetchedAt, now)
  lines.push("", age ? `Fetched ${age}.` : "Fetched just now.")
  return lines
}
