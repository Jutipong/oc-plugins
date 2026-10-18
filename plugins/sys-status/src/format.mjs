// sys-status — pure formatting helpers.
//
// Everything in this file is platform-neutral and has no I/O, so the offline
// harness can exercise it directly with Node.

const BINARY_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

export function clamp(value, min, max) {
  const number = safeNumber(value, min)
  return Math.min(max, Math.max(min, number))
}

export function safeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function hasNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
}

/** Bytes -> "16.0 GB" / "512 MB" / "123 B" (binary divisors, GB label). */
export function formatBytes(value, digits = 1) {
  if (!hasNumber(value) || value < 0) return "--"
  let number = value
  let unit = 0
  while (number >= 1024 && unit < BINARY_UNITS.length - 1) {
    number /= 1024
    unit += 1
  }
  const decimals = unit === 0 ? 0 : unit <= 2 ? 0 : digits
  return `${number.toFixed(decimals)} ${BINARY_UNITS[unit]}`
}

/** Bytes -> "158G" / "70M" / "512K" (compact, for tight lines). */
export function formatBytesShort(value) {
  if (!hasNumber(value) || value < 0) return "--"
  const units = ["B", "K", "M", "G", "T", "P"]
  let number = value
  let unit = 0
  while (number >= 1024 && unit < units.length - 1) {
    number /= 1024
    unit += 1
  }
  const decimals = unit === 0 || number >= 100 ? 0 : number >= 10 ? 0 : 1
  return `${number.toFixed(decimals)}${units[unit]}`
}

/** 0..100 -> "63.4%" / "100%" / "--". */
export function formatPercent(value, digits = 1) {
  if (!hasNumber(value)) return "--"
  const clamped = Math.max(0, Math.min(100, value))
  const decimals = clamped >= 100 || Number.isInteger(clamped) ? 0 : digits
  return `${clamped.toFixed(decimals)}%`
}

/** MB/s -> "0.01 MB/s" / "1.2 MB/s" / "39 MB/s" / "--". */
export function formatRate(megabytes) {
  if (!hasNumber(megabytes) || megabytes < 0) return "--"
  if (megabytes < 0.005) return "0 MB/s"
  const decimals = megabytes < 1 ? 2 : megabytes < 10 ? 1 : 0
  return `${megabytes.toFixed(decimals)} MB/s`
}

/** MB (base-1024) from a byte value. */
export function toMegabytes(bytes) {
  return hasNumber(bytes) ? bytes / (1024 * 1024) : null
}

export function formatWatts(watts, digits = 0) {
  if (!hasNumber(watts) || watts < 0) return null
  return `${watts.toFixed(digits)}W`
}

export function formatAmps(amps, digits = 2) {
  if (!hasNumber(amps) || amps < 0) return null
  return `${amps.toFixed(digits)}A`
}

export function formatVolts(volts, digits = 1) {
  if (!hasNumber(volts) || volts < 0) return null
  return `${volts.toFixed(digits)}V`
}

/** Progress bar as { filled, empty, width } strings of block characters. */
/** Full-block meter: █ fill + ░ track (exactly `width` cells). */
export function bar(percentValue, width = 10) {
  const cells = Math.max(1, Math.round(width))
  const value = clamp(percentValue, 0, 100)
  const filled = value <= 0 ? 0 : Math.min(cells, Math.floor((value / 100) * cells))
  return {
    filled: "█".repeat(filled),
    empty: "░".repeat(cells - filled),
    text: `${"█".repeat(filled)}${"░".repeat(cells - filled)}`,
    width: cells,
  }
}

export function barText(percentValue, width = 10) {
  return bar(percentValue, width).text
}

/** History values -> fixed-width sparkline using ▁▂▃▄▅▆▇█. */
export function sparkline(values, width = 14) {
  const cells = Math.max(1, Math.round(width))
  const source = Array.isArray(values) ? values.filter((value) => hasNumber(value)) : []
  const recent = source.slice(-cells)
  const max = recent.reduce((top, value) => (value > top ? value : top), 0)
  const line = recent.map((value) => {
    if (max <= 0) return SPARK[0]
    const index = Math.min(SPARK.length - 1, Math.floor((Math.max(0, value) / max) * (SPARK.length - 1)))
    return SPARK[index]
  })
  const pad = Math.max(0, cells - line.length)
  return `${SPARK[0].repeat(pad)}${line.join("")}`
}

/** Timestamp (ms) -> local 24h clock "21:24:05", or null. */
export function formatClock(timestamp) {
  if (!hasNumber(timestamp) || timestamp <= 0) return null
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Seconds -> "14d 16h" / "2h 10m" / "5m 3s". */
export function formatDuration(seconds) {
  if (!hasNumber(seconds) || seconds < 0) return "--"
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
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

export function displayWidth(text) {
  return [...String(text ?? "")].length
}

export function padEnd(text, width) {
  const value = String(text ?? "")
  const pad = Math.max(0, width - displayWidth(value))
  return value + " ".repeat(pad)
}

export function padStart(text, width) {
  const value = String(text ?? "")
  const pad = Math.max(0, width - displayWidth(value))
  return " ".repeat(pad) + value
}

/** Fit text to exactly `width` cells (truncate then pad). */
export function fit(text, width) {
  return padEnd(truncate(text, width), width)
}

/** Left column + right-aligned value within `width` cells. */
export function align(left, right, width) {
  const rightText = String(right ?? "")
  const rightWidth = displayWidth(rightText)
  const leftWidth = Math.max(0, width - rightWidth - 1)
  return `${fit(left, leftWidth)} ${rightText}`
}

export function separator(width, char = "─") {
  return char.repeat(Math.max(0, Math.round(width)))
}

/** Tone buckets used by the UI. */
export function toneForUsage(percentValue, warn = 70, error = 85) {
  const value = safeNumber(percentValue, 0)
  if (value >= error) return "error"
  if (value >= warn) return "warning"
  return "success"
}

export function healthTone(score) {
  const value = safeNumber(score, 0)
  if (value >= 85) return "success"
  if (value >= 65) return "warning"
  return "error"
}

export function healthLabel(score) {
  const value = safeNumber(score, 0)
  if (value >= 85) return "Excellent"
  if (value >= 65) return "Good"
  if (value >= 45) return "Fair"
  return "Poor"
}

export function normalizeKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
}

export function firstNumber(matches) {
  for (const value of matches ?? []) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

export function average(values) {
  const list = (values ?? []).filter((value) => hasNumber(value))
  if (list.length === 0) return null
  return list.reduce((sum, value) => sum + value, 0) / list.length
}
