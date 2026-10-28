// system-status — CPU / RAM / network / keyboard collector.
//
// CPU comes from `os.cpus()` deltas (no processes). RAM uses `vm_stat` on
// macOS (active + wired + compressed) and `os.freemem()` elsewhere. Network
// throughput is the byte-counter delta of the default-route interface
// (`netstat -ibn` + `route -n get default` on macOS, `/proc/net/dev` +
// `/proc/net/route` on Linux) or of the whole IP stack on Windows
// (`netstat -e`, which has no per-interface breakdown). The keyboard language
// is the HIToolbox input source on macOS and the foreground-window layout on
// Windows.
//
// The collector is reference-counted: it starts with the first subscriber
// (the prompt-footer component) and stops a few seconds after the last one,
// so nothing runs while the footer is not mounted.

import os from "node:os"
import fs from "node:fs"
import { execFile } from "node:child_process"
import { ema, toNumber } from "./format.mjs"
import {
  MAC_INPUT_SOURCE_ARGS,
  MAC_INPUT_SOURCE_BIN,
  WINDOWS_POWERSHELL_ARGS,
  parseMacInputSource,
  parseWindowsLanguage,
  windowsPowerShellPath,
} from "./keyboard.mjs"

export const DEFAULT_INTERVAL_MS = 2000
export const RAM_INTERVAL_MS = 5000
export const IDLE_STOP_MS = 5000

const BIN = {
  vmStat: "/usr/bin/vm_stat",
  netstat: "/usr/sbin/netstat",
  route: "/sbin/route",
  defaults: MAC_INPUT_SOURCE_BIN,
}

const PROC_NET_DEV = "/proc/net/dev"
const PROC_NET_ROUTE = "/proc/net/route"
const DEFAULT_ROUTE_TTL_MS = 60_000

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

/**
 * `netstat -ibn` output -> { <iface>: { in, out } } in bytes.
 *
 * Only the `<Link#N>` row of each interface is used: the per-address rows
 * repeat the same counters, so counting them would multiply the traffic.
 * Those rows may or may not carry an address column, hence the offset.
 */
export function parseNetstatCounters(text) {
  const counters = {}
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    const link = tokens.findIndex((token) => token.startsWith("<Link#"))
    if (link < 1) continue
    const name = tokens[0].replace(/\*$/, "")
    if (!name) continue
    const rest = tokens.slice(link + 1)
    const offset = rest.length >= 8 ? 1 : 0
    const inbound = Number(rest[offset + 2])
    const outbound = Number(rest[offset + 5])
    if (!Number.isFinite(inbound) || !Number.isFinite(outbound)) continue
    counters[name] = { in: inbound, out: outbound }
  }
  return counters
}

/** `route -n get default` output -> interface name. */
export function parseDefaultRouteInterface(text) {
  const match = String(text ?? "").match(/^\s*interface:\s*(\S+)/m)
  return match ? match[1] : null
}

/**
 * `netstat -e` output -> system-wide { in, out } in bytes, or null.
 *
 * Windows localizes the row labels, so the byte row is found by shape: the
 * first line that carries a label and two counters ("Discards 0 0" and its
 * kin follow it, and the header rows have no counters at all).
 */
export function parseNetstatE(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length !== 3) continue
    if (/^\d+$/.test(tokens[0])) continue
    if (!/^\d+$/.test(tokens[1]) || !/^\d+$/.test(tokens[2])) continue
    return { in: Number(tokens[1]), out: Number(tokens[2]) }
  }
  return null
}

/** Absolute `netstat.exe` on Windows, else the bare name for PATH lookup. */
export function windowsNetstatPath(env = {}) {
  const root = env.SystemRoot ?? env.windir
  return root ? `${root}\\System32\\netstat.exe` : "netstat"
}

/** `/proc/net/dev` -> { <iface>: { in, out } } in bytes. */
export function parseProcNetDev(text) {
  const counters = {}
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    if (!name) continue
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number)
    if (fields.length < 9) continue
    const [inbound, outbound] = [fields[0], fields[8]]
    if (!Number.isFinite(inbound) || !Number.isFinite(outbound)) continue
    counters[name] = { in: inbound, out: outbound }
  }
  return counters
}

/** `/proc/net/route` -> default-route interface name. */
export function parseProcRoute(text) {
  let best = null
  for (const line of String(text ?? "").split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 8) continue
    const [iface, destination, , flags, , , metric] = fields
    if (destination !== "00000000") continue
    if ((Number.parseInt(flags, 16) & 0x2) === 0) continue
    const cost = Number(metric)
    if (!best || (Number.isFinite(cost) && cost < best.cost)) best = { iface, cost: Number.isFinite(cost) ? cost : 0 }
  }
  return best?.iface ?? null
}

/** Busiest non-loopback interface, used when the default route cannot be read. */
export function pickActiveInterface(counters = {}) {
  let best = null
  for (const [name, value] of Object.entries(counters)) {
    if (/^(lo|lo0|gif|stf|bridge)/.test(name)) continue
    const total = (toNumber(value?.in) ?? 0) + (toNumber(value?.out) ?? 0)
    if (!best || total > best.total) best = { name, total }
  }
  return best?.name ?? null
}

/** Counter snapshot delta -> bytes per second, or null when a baseline is missing. */
export function rateBetween(previous, current, elapsedMs) {
  const elapsed = toNumber(elapsedMs)
  if (!previous || !current || elapsed == null || elapsed <= 0) return null
  const delta = (before, after) => Math.max(0, (toNumber(after) ?? 0) - (toNumber(before) ?? 0))
  const seconds = elapsed / 1000
  return { down: delta(previous.in, current.in) / seconds, up: delta(previous.out, current.out) / seconds }
}

function errorText(error) {
  return String(error?.message ?? error ?? "unknown error")
}

export function createCollector({
  intervalMs = DEFAULT_INTERVAL_MS,
  network = true,
  keyboard = true,
  logger,
  platform = process.platform,
  exec = defaultExec,
  readFile = (file) => fs.promises.readFile(file, "utf8"),
  now = Date.now,
  cpus = () => os.cpus(),
  totalmem = () => os.totalmem(),
  freemem = () => os.freemem(),
  env = globalThis.process?.env ?? {},
} = {}) {
  const tickMs = Math.max(500, toNumber(intervalMs) ?? DEFAULT_INTERVAL_MS)
  const netEnabled = network !== false
  const keySupported = platform === "darwin" || platform === "win32"
  const keyEnabled = keySupported && keyboard !== false

  let snapshot = { cpu: null, ram: null, stale: false, error: null, updatedAt: 0 }
  if (netEnabled) snapshot.net = null
  if (keyEnabled) snapshot.key = null
  const subscribers = new Set()
  let previousCpus = cpus()
  let previousAt = now()
  let usageEma = null
  let ramValue = null
  let ramAt = 0
  let ramInFlight = null
  let netValue = null
  let netBaseline = null
  let netInFlight = null
  let keyValue = null
  let keyInFlight = null
  let defaultIface = null
  let defaultIfaceAt = 0
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

  async function readDefaultInterface() {
    if (platform === "linux") {
      try {
        return parseProcRoute(await readFile(PROC_NET_ROUTE))
      } catch {
        return null
      }
    }
    const result = await exec(BIN.route, ["-n", "get", "default"], { timeout: 1500 })
    return result.ok ? parseDefaultRouteInterface(result.stdout) : null
  }

  /** Default-route interface (cached for DEFAULT_ROUTE_TTL_MS), else the busiest one. */
  async function resolveInterface(counters) {
    const fresh = defaultIface && now() - defaultIfaceAt < DEFAULT_ROUTE_TTL_MS
    if (!fresh) {
      const found = await readDefaultInterface()
      if (found) {
        defaultIface = found
        defaultIfaceAt = now()
      }
    }
    if (defaultIface && counters[defaultIface]) return defaultIface
    const fallback = pickActiveInterface(counters)
    if (fallback) {
      defaultIface = fallback
      defaultIfaceAt = now()
    }
    return fallback
  }

  async function readNetCounters() {
    try {
      if (platform === "linux") {
        const counters = parseProcNetDev(await readFile(PROC_NET_DEV))
        const iface = await resolveInterface(counters)
        return iface && counters[iface] ? { iface, ...counters[iface] } : null
      }
      if (platform === "darwin") {
        const result = await exec(BIN.netstat, ["-ibn"], { timeout: 2000 })
        if (!result.ok) return null
        const counters = parseNetstatCounters(result.stdout)
        const iface = await resolveInterface(counters)
        return iface && counters[iface] ? { iface, ...counters[iface] } : null
      }
      if (platform === "win32") {
        // `netstat -e` only reports the totals of the whole IP stack, so there
        // is no interface to resolve and the rate follows every adapter.
        const result = await exec(windowsNetstatPath(env), ["-e"], { timeout: 1500 })
        if (!result.ok) return null
        const counters = parseNetstatE(result.stdout)
        return counters ? { iface: "system", ...counters } : null
      }
    } catch (error) {
      logger?.write?.(`net failed: ${errorText(error)}`)
    }
    return null
  }

  function refreshNet() {
    if (netInFlight || disposed) return netInFlight
    netInFlight = (async () => {
      try {
        const counters = await readNetCounters()
        const at = now()
        if (counters) {
          // A new baseline (first sample, interface switch) yields no rate yet.
          const previous = netBaseline && netBaseline.iface === counters.iface ? netBaseline : null
          const rate = previous ? rateBetween(previous, counters, at - previous.at) : null
          netValue = rate ?? null
          netBaseline = { ...counters, at }
        }
      } catch (error) {
        logger?.write?.(`net failed: ${errorText(error)}`)
      } finally {
        netInFlight = null
        snapshot = { ...snapshot, net: netValue }
        publish()
      }
    })()
    return netInFlight
  }

  async function readKeyboard() {
    if (platform === "darwin") {
      const result = await exec(BIN.defaults, MAC_INPUT_SOURCE_ARGS, { timeout: 1500 })
      return result.ok ? parseMacInputSource(result.stdout) : null
    }
    if (platform === "win32") {
      const result = await exec(windowsPowerShellPath(env), WINDOWS_POWERSHELL_ARGS, { timeout: 4000 })
      return result.ok ? parseWindowsLanguage(result.stdout) : null
    }
    return null
  }

  /** Runs on every tick like NET; the in-flight guard keeps a slow Windows probe from stacking. */
  function refreshKeyboard() {
    if (!keyEnabled || keyInFlight || disposed) return keyInFlight
    keyInFlight = (async () => {
      try {
        const value = await readKeyboard()
        if (value != null) keyValue = value
      } catch (error) {
        logger?.write?.(`keyboard failed: ${errorText(error)}`)
      } finally {
        keyInFlight = null
        snapshot = { ...snapshot, key: keyValue }
        publish()
      }
    })()
    return keyInFlight
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

    if (netEnabled) void refreshNet()
    if (keyEnabled) void refreshKeyboard()
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
