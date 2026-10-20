// system-status — CPU / RAM collector.
//
// CPU comes from `os.cpus()` deltas (no processes). RAM uses `vm_stat` on
// macOS (active + wired + compressed) and `os.freemem()` elsewhere.
//
// The collector is reference-counted: it starts with the first subscriber
// (the prompt-footer component) and stops a few seconds after the last one,
// so nothing runs while the footer is not mounted.

import os from "node:os"
import { execFile } from "node:child_process"
import { ema, toNumber } from "./format.mjs"

export const DEFAULT_INTERVAL_MS = 2000
export const RAM_INTERVAL_MS = 5000
export const IDLE_STOP_MS = 5000

const BIN = {
  vmStat: "/usr/bin/vm_stat",
}

function defaultExec(command, args, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: stdout ?? "", error: error ?? null })
    })
  })
}

/** Busy-time ratio per core and overall; the denominator floors at the wall clock. */
export function sampleCpu(previous, current, elapsedMs) {
  const perCore = []
  let busyTotal = 0
  let denomTotal = 0
  const floor = Math.max(1, Math.min(toNumber(elapsedMs) ?? 1, 10_000))
  for (let index = 0; index < current.length; index += 1) {
    const now = current[index]?.times
    const before = previous[index]?.times
    if (!now || !before) {
      perCore.push(0)
      continue
    }
    const busy =
      Math.max(0, now.user - before.user) +
      Math.max(0, now.nice - before.nice) +
      Math.max(0, now.sys - before.sys) +
      Math.max(0, now.irq - before.irq)
    const idle = Math.max(0, now.idle - before.idle)
    const denom = Math.max(busy + idle, floor)
    busyTotal += busy
    denomTotal += denom
    perCore.push(Math.min(100, Math.max(0, (busy / denom) * 100)))
  }
  return {
    usage: denomTotal > 0 ? Math.min(100, Math.max(0, (busyTotal / denomTotal) * 100)) : null,
    perCore,
  }
}

/** vm_stat output -> used bytes (active + wired + compressed). */
export function parseVmStatUsed(text, fallbackPageSize = 16384) {
  let pageSize = fallbackPageSize
  const pages = { active: 0, wired: 0, compressed: 0 }
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const sizeMatch = line.match(/page size of (\d+) bytes/i)
    if (sizeMatch) pageSize = Number(sizeMatch[1])
    const match = line.match(/^"?([^":]+)"?:\s+(\d+)\.?\s*$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    const value = Number(match[2])
    if (!Number.isFinite(value)) continue
    if (key === "pages active") pages.active = value
    else if (key === "pages wired down") pages.wired = value
    else if (key === "pages occupied by compressor") pages.compressed = value
  }
  return (pages.active + pages.wired + pages.compressed) * pageSize
}

function errorText(error) {
  return String(error?.message ?? error ?? "unknown error")
}

export function createCollector({
  intervalMs = DEFAULT_INTERVAL_MS,
  logger,
  platform = process.platform,
  exec = defaultExec,
  now = Date.now,
  cpus = () => os.cpus(),
  totalmem = () => os.totalmem(),
  freemem = () => os.freemem(),
} = {}) {
  const tickMs = Math.max(500, toNumber(intervalMs) ?? DEFAULT_INTERVAL_MS)

  let snapshot = { cpu: null, ram: null, stale: false, error: null, updatedAt: 0 }
  const subscribers = new Set()
  let previousCpus = cpus()
  let previousAt = now()
  let usageEma = null
  let ramValue = null
  let ramAt = 0
  let ramInFlight = null
  let timer = null
  let idleTimer = null
  let running = false
  let disposed = false

  function publish() {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(snapshot)
      } catch {
        // A broken subscriber must not break the collector.
      }
    }
  }

  async function readRam() {
    if (platform === "darwin") {
      const result = await exec(BIN.vmStat, [], { timeout: 1200 })
      if (!result.ok) return null
      const used = parseVmStatUsed(result.stdout)
      const total = toNumber(totalmem())
      return total ? Math.max(0, Math.min(100, (used / total) * 100)) : null
    }
    const total = toNumber(totalmem())
    const free = toNumber(freemem())
    if (!total || free == null) return null
    return Math.max(0, Math.min(100, ((total - free) / total) * 100))
  }

  function refreshRam() {
    if (ramInFlight) return ramInFlight
    ramInFlight = (async () => {
      try {
        const value = await readRam()
        if (value != null) {
          ramValue = value
          ramAt = now()
        }
      } catch (error) {
        logger?.write?.(`ram failed: ${errorText(error)}`)
      } finally {
        ramInFlight = null
        snapshot = { ...snapshot, ram: ramValue }
        publish()
      }
    })()
    return ramInFlight
  }

  async function tick() {
    timer = null
    if (!running || disposed) return
    const at = now()
    try {
      const current = cpus()
      const { usage } = sampleCpu(previousCpus, current, at - previousAt)
      previousCpus = current
      previousAt = at
      if (usage != null) usageEma = ema(usageEma, usage, 0.35)
      snapshot = { ...snapshot, cpu: usageEma, stale: false, error: null, updatedAt: at }
    } catch (error) {
      snapshot = { ...snapshot, stale: true, error: errorText(error), updatedAt: at }
      logger?.write?.(`cpu failed: ${errorText(error)}`)
    }
    publish()

    if (!ramInFlight && (ramAt === 0 || at - ramAt >= RAM_INTERVAL_MS)) void refreshRam()
    if (running && !disposed) timer = setTimeout(() => void tick(), tickMs)
  }

  function start() {
    if (running || disposed) return
    running = true
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    previousCpus = cpus()
    previousAt = now() - tickMs
    void tick()
  }

  function stop() {
    running = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  return {
    get() {
      return snapshot
    },
    subscribe(listener) {
      subscribers.add(listener)
      try {
        listener(snapshot)
      } catch {
        // Initial delivery is best-effort.
      }
      start()
      return () => {
        subscribers.delete(listener)
        if (subscribers.size > 0) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (subscribers.size === 0) stop()
        }, IDLE_STOP_MS)
      }
    },
    start,
    stop,
    dispose() {
      disposed = true
      subscribers.clear()
      stop()
    },
  }
}
