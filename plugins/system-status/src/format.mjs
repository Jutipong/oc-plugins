// system-status — pure formatting helpers (no I/O, no OpenTUI).

/** Number / bigint / numeric string -> number, or null when unusable. */
export function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  const base = Number.isFinite(number) && number > 0 ? number : fallback
  return Math.min(max, Math.max(min, Math.round(base)))
}

export function displayWidth(text) {
  return [...String(text ?? "")].length
}

/** Unicode-aware truncate with an ellipsis. */
export function truncate(text, width) {
  const value = text == null ? "" : String(text)
  const cells = Math.max(0, Math.round(width))
  const chars = [...value]
  if (chars.length <= cells) return value
  if (cells <= 1) return "…"
  return `${chars.slice(0, cells - 1).join("")}…`
}

/** Usage buckets shared across the CLI plugins: >= danger (80) red, >= warning (50) amber. */
export function toneForUsage(percent, warning = 50, danger = 80) {
  const value = toNumber(percent)
  if (value == null) return "muted"
  if (value >= danger) return "danger"
  if (value >= warning) return "warning"
  return "success"
}

/** 0-100 -> "37%", or "—" when unknown. */
export function formatPercent(value) {
  const number = toNumber(value)
  return number == null ? "—" : `${Math.round(number)}%`
}

const RATE_UNITS = ["B", "K", "M", "G", "T"]

/**
 * Bytes per second -> a compact 1-4 cell label: `"512B"`, `"3.4K"`, `"12K"`,
 * `"1.2M"`, `"340M"`, or `"—"` when unknown. 1 K = 1024 B.
 */
export function formatRate(bytesPerSecond) {
  const value = toNumber(bytesPerSecond)
  if (value == null || value < 0) return "—"
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < RATE_UNITS.length - 1) {
    amount /= 1024
    unit += 1
  }
  if (unit === 0) return amount < 999.5 ? `${Math.round(amount)}B` : "1.0K"
  return `${amount < 9.95 ? amount.toFixed(1) : Math.round(amount)}${RATE_UNITS[unit]}`
}

/** Exponential moving average, used to smooth CPU load between ticks. */
export function ema(previous, next, alpha = 0.35) {
  const value = toNumber(next)
  if (value == null) return previous ?? null
  const prior = toNumber(previous)
  return prior == null ? value : prior + alpha * (value - prior)
}
