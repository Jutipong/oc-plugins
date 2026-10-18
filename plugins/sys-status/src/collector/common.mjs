// sys-status — shared collector helpers (platform-neutral).

import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function createRingBuffer(capacity = 16) {
  const size = Math.max(1, Math.round(capacity))
  const data = []
  return {
    push(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return
      data.push(value)
      while (data.length > size) data.shift()
    },
    toArray() {
      return data.slice()
    },
    get length() {
      return data.length
    },
    clear() {
      data.length = 0
    },
  }
}

export function ema(previous, next, alpha = 0.3) {
  if (typeof next !== "number" || !Number.isFinite(next)) return previous ?? null
  if (typeof previous !== "number" || !Number.isFinite(previous)) return next
  const weight = Math.min(1, Math.max(0, alpha))
  return previous * (1 - weight) + next * weight
}

export function createDeltaTracker() {
  const previous = new Map()
  return {
    /** Returns a per-second rate for a monotonically increasing counter. */
    update(key, value, now) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null
      const prev = previous.get(key)
      previous.set(key, { value, at: now })
      if (!prev) return null
      const elapsed = (now - prev.at) / 1000
      if (elapsed <= 0) return null
      const delta = value - prev.value
      if (delta < 0) return 0
      return delta / elapsed
    },
    reset() {
      previous.clear()
    },
  }
}

/**
 * Runs a command without a shell. Never rejects: the caller always receives
 * stdout/stderr/exit code so a missing command or timeout degrades gracefully.
 */
export function run(command, args = [], options = {}) {
  const timeout = options.timeout ?? 1500
  const maxBuffer = options.maxBuffer ?? 2 * 1024 * 1024
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        command,
        args,
        {
          timeout,
          maxBuffer,
          windowsHide: true,
          encoding: "utf8",
          env: options.env ? { ...process.env, ...options.env } : process.env,
        },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            code: error?.code ?? 0,
            signal: error?.signal ?? null,
            timedOut: Boolean(error?.killed),
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          })
        },
      )
    } catch (error) {
      resolve({ ok: false, code: -1, signal: null, timedOut: false, stdout: "", stderr: String(error?.message ?? error) })
      return
    }
    if (typeof options.onChild === "function" && child) options.onChild(child)
  })
}

export function createLogger(enabled) {
  const logPath = path.join(os.homedir(), ".config", "opencode", "plugins", "sys-status-debug.log")
  function write(level, args) {
    if (!enabled) return
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 512 * 1024) {
        fs.renameSync(logPath, `${logPath}.bak`)
      }
      const line = `${new Date().toISOString()} ${level} ${args
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" ")}\n`
      fs.appendFileSync(logPath, line)
    } catch {
      // Debug logging must never take the UI down.
    }
  }
  return {
    debug: (...args) => write("DEBUG", args),
    warn: (...args) => write("WARN", args),
    error: (...args) => write("ERROR", args),
  }
}

export function baseSnapshot() {
  return {
    platform: process.platform,
    updatedAt: 0,
    unsupported: false,
    uptimeSec: null,
    hardware: {},
    cpu: { usage: null, perCore: [], load1: null, load5: null, load15: null, physical: null, logical: null, pCores: null, eCores: null, speedGhz: null, detail: null },
    memory: { used: null, total: null, free: null, available: null, cached: null, usedPercent: null, swapUsed: null, swapTotal: null },
    disk: { mount: null, total: null, used: null, free: null, usedPercent: null, readRate: null, writeRate: null },
    power: {
      present: false,
      percent: null,
      status: null,
      healthPercent: null,
      healthLabel: null,
      cycles: null,
      acWatts: null,
      adapterWatts: null,
      systemWatts: null,
      systemAmps: null,
      systemVolts: null,
      batteryWatts: null,
      batteryAmps: null,
      batteryVolts: null,
      externalConnected: null,
      charging: null,
      fullyCharged: null,
      timeLeft: null,
    },
    network: { name: null, ip: null, gateway: null, rxRate: null, txRate: null, rxHistory: [], txHistory: [], tunnel: false },
    health: { score: 0, label: "Poor", message: "Collecting…", tone: "error" },
    errors: [],
  }
}

function mergable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Deep-merge a patch over a snapshot; undefined/null values keep the old value. */
export function mergeSnapshot(base, patch) {
  if (!patch) return base
  const output = Array.isArray(base) ? base.slice() : { ...(base ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) continue
    if (Array.isArray(value)) {
      output[key] = value.slice()
      continue
    }
    if (mergable(value) && mergable(output[key])) {
      output[key] = mergeSnapshot(output[key], value)
      continue
    }
    output[key] = value
  }
  return output
}
