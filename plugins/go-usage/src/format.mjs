// go-usage — pure formatting helpers (no I/O, no OpenTUI).

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

/** Usage buckets shared across the CLI plugins: >= 80 danger, >= 50 warning, else success. */
export function toneForMeter(percentValue) {
  const value = toNumber(percentValue) ?? 0
  if (value >= 80) return "danger"
  if (value >= 50) return "warning"
  return "success"
}

/**
 * Live output speed -> compact label: `"45"`, `"7.4"` below 10, `"0"` when
 * idle and `"—"` when unusable. One decimal only under 10 so the cell count
 * stays small.
 */
export function formatTps(value) {
  const number = toNumber(value)
  if (number == null) return "—"
  if (number <= 0) return "0"
  return number < 9.95 ? number.toFixed(1) : String(Math.round(number))
}

/** Speed buckets: >= 150 hot, >= 100 success, >= 60 warning, else danger. */
export function toneForTps(value) {
  const number = toNumber(value) ?? 0
  if (number >= 150) return "hot"
  if (number >= 100) return "success"
  if (number >= 60) return "warning"
  return "danger"
}

/**
 * Reset countdown, mirroring the console formatter: minutes are rounded up
 * and only the two largest units are shown ("0h 31m", "12h 12m", "9d 14h").
 */
export function formatReset(resetsAt, now = Date.now()) {
  const target = toTime(resetsAt)
  if (target == null) return null
  const current = toNumber(now) ?? Date.now()
  const minutes = Math.max(0, Math.ceil((target - current) / 60000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return `${hours}h ${minutes % 60}m`
}
