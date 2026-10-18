// sys-status — collector entry point.
//
// One collector per TUI process. It samples CPU from `os.cpus()` deltas in
// process, delegates platform-specific metrics to darwin.mjs / win32.mjs, and
// publishes a merged immutable snapshot to subscribers. Subscribers are
// reference-counted: the collector only runs while the sidebar is mounted, and
// stops a few seconds after it leaves.

import os from "node:os"
import { baseSnapshot, createLogger, ema, mergeSnapshot } from "./common.mjs"
import { computeHealth } from "../health.mjs"
import { createDarwinSource } from "./darwin.mjs"
import { createWindowsSource } from "./win32.mjs"

export const DEFAULT_INTERVAL_MS = 2000
const IDLE_STOP_MS = 5000

export function createCollector(options = {}) {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS)
  const platform = options.platform ?? process.platform
  const logger = options.logger ?? createLogger(process.env.SYS_STATUS_DEBUG === "1")
  const source =
    platform === "darwin"
      ? createDarwinSource({ logger })
      : platform === "win32"
        ? createWindowsSource({ logger })
        : createUnsupportedSource()

  const subscribers = new Set()
  let snapshot = baseSnapshot()
  let running = false
  let timer = null
  let idleTimer = null
  let stopped = false

  let prevCpus = os.cpus()
  let prevAt = Date.now()
  let usageEma = null

  function publish() {
    for (const subscriber of subscribers) {
      try {
        subscriber(snapshot)
      } catch (error) {
        logger?.warn?.("subscriber failed", String(error?.message ?? error))
      }
    }
  }

  async function tick() {
    timer = null
    if (!running || stopped) return
    const now = Date.now()
    let patch = null
    try {
      patch = await source.sample(now)
    } catch (error) {
      logger?.error?.("sample failed", String(error?.message ?? error))
      patch = { errors: [String(error?.message ?? error)] }
    }

    const currentCpus = os.cpus()
    const elapsed = Math.max(1, now - prevAt)
    const cpu = sampleCpu(prevCpus, currentCpus, elapsed)
    prevCpus = currentCpus
    prevAt = now
    if (cpu.usage != null) usageEma = ema(usageEma, cpu.usage, 0.35)

    snapshot = mergeSnapshot(snapshot, patch)
    snapshot.platform = platform
    snapshot.updatedAt = now
    snapshot.uptimeSec = os.uptime()
    const detectedSpeed = currentCpus[0]?.speed ? currentCpus[0].speed / 1000 : null
    snapshot.cpu = {
      ...snapshot.cpu,
      usage: usageEma,
      perCore: cpu.perCore,
      speedGhz: snapshot.cpu.speedGhz ?? detectedSpeed,
    }
    snapshot.memory = buildMemory(snapshot.memory, os)
    snapshot.health = computeHealth(snapshot)
    if (!Array.isArray(snapshot.errors)) snapshot.errors = []
    publish()

    if (running && !stopped) timer = setTimeout(tick, intervalMs)
  }

  function start() {
    if (running || stopped) return
    running = true
    source.start?.()
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (!timer) timer = setTimeout(tick, intervalMs)
  }

  function stopLoop() {
    running = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    source.stop?.()
  }

  return {
    subscribe(handler) {
      if (typeof handler !== "function") return () => {}
      subscribers.add(handler)
      if (snapshot.updatedAt > 0) {
        try {
          handler(snapshot)
        } catch (error) {
          logger?.warn?.("subscriber failed", String(error?.message ?? error))
        }
      }
      start()
      return () => {
        subscribers.delete(handler)
        if (subscribers.size === 0 && running && !stopped) {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            idleTimer = null
            if (subscribers.size === 0) stopLoop()
          }, IDLE_STOP_MS)
        }
      }
    },
    getSnapshot() {
      return snapshot
    },
    stop() {
      stopped = true
      subscribers.clear()
      stopLoop()
    },
    get intervalMs() {
      return intervalMs
    },
  }
}

export function clampInterval(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return DEFAULT_INTERVAL_MS
  return Math.min(10_000, Math.max(1000, Math.round(milliseconds)))
}

/**
 * Per-core usage from two `os.cpus()` snapshots. The denominator is floored at
 * the wall-clock window so a parked Apple Silicon core (whose idle ticks stop
 * accumulating) counts as idle instead of 100% busy.
 */
export function sampleCpu(previous, current, elapsedMs) {
  const perCore = []
  let busyTotal = 0
  let denomTotal = 0
  const floor = Math.max(1, Math.min(elapsedMs, 10_000))
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
    usage: denomTotal > 0 ? Math.min(100, (busyTotal / denomTotal) * 100) : null,
    perCore,
  }
}

function buildMemory(memory, osModule) {
  const next = { ...(memory ?? {}) }
  const total = next.total ?? osModule.totalmem()
  const free = next.free ?? osModule.freemem()
  const used = next.used ?? (total != null && free != null ? Math.max(0, total - free) : null)
  const available = next.available ?? (total != null && used != null ? Math.max(0, total - used) : null)
  const usedPercent = next.usedPercent ?? (total && used != null ? (used / total) * 100 : null)
  return { ...next, total, free, used, available, usedPercent }
}

function createUnsupportedSource() {
  return {
    start() {},
    async sample() {
      return {
        unsupported: true,
        errors: [`sys-status does not support platform "${process.platform}" yet (macOS and Windows only)`],
      }
    },
    stop() {},
  }
}
