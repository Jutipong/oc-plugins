// sys-status — health score.
//
// This is an original, transparent heuristic. It is intentionally NOT a port
// of Mole's GPL-3.0 scoring code; Mole is only the visual inspiration for the
// dashboard. The formula is documented in the plugin README.
//
// Calibration on a healthy MacBook Air M1 (CPU ~40%, memory ~63%, disk ~73%,
// battery health 88%, uptime ~14 days) reads 97 / Excellent / "Restart
// Recommended", which matches the reference dashboard's mood.

import { clamp, hasNumber, safeNumber } from "./format.mjs"

export const HEALTH_BANDS = {
  excellent: 85,
  good: 65,
  fair: 45,
}

export function computeHealth(snapshot) {
  const value = snapshot ?? {}
  const cpuUsage = safeNumber(value.cpu?.usage, 0)
  const memoryPercent = safeNumber(value.memory?.usedPercent, 0)
  const diskPercent = safeNumber(value.disk?.usedPercent, 0)
  const batteryHealth = value.power?.present === false ? null : value.power?.healthPercent
  const cycles = value.power?.cycles
  const uptime = safeNumber(value.uptimeSec, 0)
  const ioTotal =
    (hasNumber(value.disk?.readRate) ? value.disk.readRate : 0) +
    (hasNumber(value.disk?.writeRate) ? value.disk.writeRate : 0)

  let score = 100
  const issues = []

  if (cpuUsage > 50) {
    score -= 25 * ((cpuUsage - 50) / 50)
  }
  if (cpuUsage > 85) issues.push("High CPU")

  if (memoryPercent > 70) {
    score -= 25 * ((memoryPercent - 70) / 30)
  }
  if (memoryPercent > 88) issues.push("High Memory")

  if (diskPercent > 80) {
    score -= 20 * ((diskPercent - 80) / 20)
  }
  if (diskPercent > 90) issues.push("Disk Almost Full")

  if (hasNumber(batteryHealth) && batteryHealth < 80) {
    score -= 15 * ((80 - batteryHealth) / 80)
    issues.push("Service Battery")
  }
  if (hasNumber(cycles) && cycles > 900) {
    score -= 5
    if (!issues.includes("Service Battery")) issues.push("Battery Cycles High")
  }

  if (ioTotal > 200) score -= 5
  if (ioTotal > 500) score -= 5

  if (uptime > 30 * 86400) {
    score -= 7
  } else if (uptime > 14 * 86400) {
    score -= 3
  } else if (uptime > 7 * 86400) {
    score -= 2
  }
  if (uptime > 14 * 86400) issues.push("Restart Recommended")

  const final = Math.round(clamp(score, 0, 100))
  const label =
    final >= HEALTH_BANDS.excellent
      ? "Excellent"
      : final >= HEALTH_BANDS.good
        ? "Good"
        : final >= HEALTH_BANDS.fair
          ? "Fair"
          : "Poor"
  const tone = final >= HEALTH_BANDS.excellent ? "success" : final >= HEALTH_BANDS.good ? "warning" : "error"
  const message = issues[0] ?? "All systems normal"

  return { score: final, label, message, tone }
}
