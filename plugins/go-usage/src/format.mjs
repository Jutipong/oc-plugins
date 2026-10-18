// go-usage — pure formatting helpers (no I/O, no OpenTUI).
//
// Everything here is exercised directly by the offline harness. The bar is the
// sys-status "mole" meter: whole cells only, `█` fill and a `░` track.

const DOLLAR_PER_MICRO_CENT = 1e8
const FILL = "█"
const TRACK = "░"

export function safeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function hasNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
}

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

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, safeNumber(value, min)))
}

/**
 * Date-ish value -> epoch milliseconds, or null.
 * Accepts Date, ISO strings, epoch seconds (< 1e12) and epoch millis.
 */
export function toTime(value) {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    return toTime(toNumber(value))
  }
  const number = toNumber(value)
  if (number == null || number <= 0) return null
  return number < 1e12 ? number * 1000 : number
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

export function padEnd(text, width) {
  const value = String(text ?? "")
  return value + " ".repeat(Math.max(0, width - displayWidth(value)))
}

export function padStart(text, width) {
  const value = String(text ?? "")
  return " ".repeat(Math.max(0, width - displayWidth(value))) + value
}

/** Fit text to exactly `width` cells (truncate then pad). */
export function fit(text, width) {
  return padEnd(truncate(text, width), width)
}

/**
 * btop / sys-status "mole" meter bar: whole `█` cells for the filled part
 * (floor, no partial edge) and a `░` track. Always renders exactly `width`
 * cells; the caller decides the colors.
 */
export function bar(percentValue, width = 36) {
  const cells = Math.max(1, Math.round(width))
  const value = clamp(percentValue, 0, 100)
  const filled = value <= 0 ? 0 : Math.min(cells, Math.floor((value / 100) * cells))
  return {
    filled: FILL.repeat(filled),
    empty: TRACK.repeat(cells - filled),
    text: `${FILL.repeat(filled)}${TRACK.repeat(cells - filled)}`,
    width: cells,
  }
}

export function barText(percentValue, width = 36) {
  return bar(percentValue, width).text
}

/** Console tone buckets: > 95 danger, >= 70 warning, else success. */
export function toneForMeter(percentValue) {
  const value = safeNumber(percentValue, 0)
  if (value > 95) return "danger"
  if (value >= 70) return "warning"
  return "success"
}

/**
 * Reset countdown, mirroring the console formatter: minutes are rounded up
 * and only the two largest units are shown ("0h 31m", "12h 12m", "9d 14h").
 */
export function formatReset(resetsAt, now = Date.now()) {
  const target = toTime(resetsAt)
  if (target == null) return null
  const current = hasNumber(now) ? now : Date.now()
  const minutes = Math.max(0, Math.ceil((target - current) / 60000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return `${hours}h ${minutes % 60}m`
}

/** microCents (1e8 per dollar) -> "$12.00". */
export function formatMoney(microCents, fallback = "--") {
  const value = toNumber(microCents)
  if (value == null || value < 0) return fallback
  return `$${(value / DOLLAR_PER_MICRO_CENT).toFixed(2)}`
}

/** Fetched-at timestamp -> "just now" / "12s ago" / "3m ago" / "2h ago". */
export function formatAge(fetchedAt, now = Date.now()) {
  const at = toNumber(fetchedAt)
  if (at == null || at <= 0) return null
  const current = hasNumber(now) ? now : Date.now()
  const seconds = Math.max(0, Math.floor((current - at) / 1000))
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Fetched-at timestamp -> local 24h clock "22:31:05", or null. */
export function formatClock(fetchedAt) {
  const at = toNumber(fetchedAt)
  if (at == null || at <= 0) return null
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
