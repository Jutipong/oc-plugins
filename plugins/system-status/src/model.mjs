// system-status — view state -> the prompt-footer line.
//
// One narrow row: `[CPU:37% · RAM:62% · ↓1.2M ↑240K]`. Labels are muted,
// values carry the threshold tone, brackets/separators stay faint. Pure so the
// harness can assert every state without spawning anything.

import { displayWidth, formatPercent, formatRate, toneForUsage, truncate } from "./format.mjs"

const DEFAULT_WIDTH = 36

/** Network rate -> `↓1.2M ↑240K` (label-free, arrows are the labels). */
export function formatNetwork(net) {
  if (!net) return "↓— ↑—"
  return `↓${formatRate(net.down)} ↑${formatRate(net.up)}`
}

/** Throughput has no meaningful percent ceiling: tone it by activity instead. */
function toneForNetwork(net) {
  if (!net) return "muted"
  return net.down > 0 || net.up > 0 ? "success" : "muted"
}

/**
 * Footer fields in display order; `enabled` drops a field that is switched off
 * and a missing `label` means the value stands on its own (NET's arrows).
 */
export const STATUS_FIELDS = [
  { label: "CPU:", text: (view) => formatPercent(view.cpu), tone: (view) => toneForUsage(view.cpu, 50, 80) },
  { label: "RAM:", text: (view) => formatPercent(view.ram), tone: (view) => toneForUsage(view.ram, 50, 80) },
  {
    text: (view) => formatNetwork(view.net),
    tone: (view) => toneForNetwork(view.net),
    enabled: (view) => view.net !== undefined,
  },
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

/** Join field groups with faint ` · ` separators. */
function fieldSegments(fields) {
  const line = []
  fields.forEach((parts, index) => {
    if (index > 0) line.push(seg(" · ", "faint"))
    line.push(...parts)
  })
  return line
}

/**
 * Bracket the fields, dropping trailing fields whole when the row is narrow.
 * The brackets are always kept; if even one field overflows, the inside is
 * truncated but the closing bracket stays.
 */
function bracketLine(fields, budget) {
  for (let count = fields.length; count >= 1; count -= 1) {
    const line = [seg("[", "faint"), ...fieldSegments(fields.slice(0, count)), seg("]", "faint")]
    if (lineWidth(line) <= budget) return line
  }
  const inner = fieldSegments(fields)
  return [seg("[", "faint"), ...clipLine(inner, Math.max(0, budget - 2)), seg("]", "faint")]
}

/**
 * `prompt.footer.status` line.
 *
 * view: { cpu, ram, net, stale, error, updatedAt }
 *   cpu/ram — percent 0-100 or null
 *   net     — { down, up } in bytes/second, null while pending,
 *             undefined when the network field is switched off
 *
 * options:
 *   width — max cells (default 36)
 */
export function buildPromptLine(view = {}, options = {}) {
  const width = Math.max(8, Math.round(options.width ?? DEFAULT_WIDTH))
  const fields = STATUS_FIELDS.filter((field) => (field.enabled ? field.enabled(view) : true)).map(
    ({ label, text, tone }) => {
      const parts = label ? [seg(label, "muted")] : []
      parts.push(seg(text(view), tone(view)))
      return parts
    },
  )
  const prefix = view.stale ? [seg("! ", "warning")] : []
  const budget = Math.max(0, width - lineWidth(prefix))
  return [...prefix, ...bracketLine(fields, budget)]
}
