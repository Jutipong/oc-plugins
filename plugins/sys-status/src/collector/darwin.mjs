// sys-status — macOS collector.
//
// Uses only built-in system tools (vm_stat, df, netstat, sysctl, ioreg,
// pmset, route, system_profiler). No Homebrew, no `mo`, no external packages.
// Commands are invoked directly (never through a shell) with per-command
// timeouts, and every failure keeps the previous value instead of throwing.

import { createRingBuffer, createDeltaTracker, run } from "./common.mjs"
import {
  parseDefaultRoute,
  parseDf,
  parseIoregBattery,
  parseIoregStorageStats,
  parseNetstatIb,
  parsePmset,
  parseSysctl,
  parseSystemProfilerDisplays,
  parseSystemProfilerHardware,
  parseSystemProfilerPower,
  parseVmStat,
} from "../parser.mjs"
import { toMegabytes } from "../format.mjs"

const BIN = {
  vmStat: "/usr/bin/vm_stat",
  df: "/bin/df",
  netstat: "/usr/sbin/netstat",
  sysctl: "/usr/sbin/sysctl",
  ioreg: "/usr/sbin/ioreg",
  pmset: "/usr/bin/pmset",
  route: "/sbin/route",
  systemProfiler: "/usr/sbin/system_profiler",
}

const TUNNEL_PATTERN = /^(utun|ppp|ipsec|tap|tun)/

export function createDarwinSource({ logger } = {}) {
  const netDeltas = createDeltaTracker()
  const ioDeltas = createDeltaTracker()
  const rxHistory = createRingBuffer(14)
  const txHistory = createRingBuffer(14)

  let cache = {
    hardware: {},
    memory: {},
    disk: {},
    network: {},
    power: {},
    cpu: {},
    errors: [],
  }
  let next = { fast: 0, medium: 0, slow: 0, static: 0 }

  async function loadStatic() {
    const [sysctlResult, hardwareResult, displaysResult, powerResult, batteryResult] = await Promise.all([
      run(BIN.sysctl, [
        "hw.model",
        "machdep.cpu.brand_string",
        "hw.memsize",
        "hw.ncpu",
        "hw.perflevel0.physicalcpu",
        "hw.perflevel1.physicalcpu",
        "kern.osproductversion",
        "hw.optional.arm64",
      ], { timeout: 1200 }),
      run(BIN.systemProfiler, ["SPHardwareDataType", "-json"], { timeout: 5000 }),
      run(BIN.systemProfiler, ["SPDisplaysDataType", "-json"], { timeout: 5000 }),
      run(BIN.systemProfiler, ["SPPowerDataType", "-json"], { timeout: 5000 }),
      run(BIN.ioreg, ["-rc", "AppleSmartBattery", "-w0"], { timeout: 1500 }),
    ])

    const sysctl = parseSysctl(sysctlResult.stdout) ?? {}
    const hardware = hardwareResult.ok ? parseSystemProfilerHardware(hardwareResult.stdout) : null
    const displays = displaysResult.ok ? parseSystemProfilerDisplays(displaysResult.stdout) : null
    const profilerPower = powerResult.ok ? parseSystemProfilerPower(powerResult.stdout) : null
    const ioregBattery = batteryResult.ok ? parseIoregBattery(batteryResult.stdout) : null

    const name = hardware?.name ?? sysctl.model ?? null
    const power = {
      healthPercent: profilerPower?.healthPercent ?? ioregBattery?.healthPercent ?? null,
      healthLabel: profilerPower?.health ?? null,
      cycles: profilerPower?.cycles ?? ioregBattery?.cycles ?? null,
      acWatts: profilerPower?.acWatts ?? null,
      adapterWatts: ioregBattery?.adapterWatts ?? profilerPower?.acWatts ?? null,
      systemWatts: ioregBattery?.systemWatts ?? null,
      systemAmps: ioregBattery?.systemAmps ?? null,
      systemVolts: ioregBattery?.systemVolts ?? null,
      batteryWatts: ioregBattery?.batteryWatts ?? null,
      batteryAmps: ioregBattery?.batteryAmps ?? null,
      batteryVolts: ioregBattery?.batteryVolts ?? null,
      externalConnected: ioregBattery?.externalConnected ?? null,
      charging: ioregBattery?.charging ?? null,
      fullyCharged: ioregBattery?.fullyCharged ?? null,
      temperature: ioregBattery?.temperature ?? null,
    }

    cache = {
      ...cache,
      hardware: {
        name,
        model: hardware?.model ?? sysctl.model ?? null,
        chip: sysctl.chip ?? null,
        totalRam: sysctl.memsize ?? null,
        physical: sysctl.pCores && sysctl.eCores ? sysctl.pCores + sysctl.eCores : sysctl.ncpu ?? null,
        logical: sysctl.ncpu ?? null,
        pCores: sysctl.pCores ?? null,
        eCores: sysctl.eCores ?? null,
        osVersion: sysctl.osVersion ? `macOS ${sysctl.osVersion}` : null,
        refreshRate: displays?.refreshRate ?? null,
        gpuName: displays?.gpuName ?? null,
        gpuCores: displays?.gpuCores ?? null,
      },
      power: { ...cache.power, ...power },
      cpu: {
        ...cache.cpu,
        physical: sysctl.pCores && sysctl.eCores ? sysctl.pCores + sysctl.eCores : sysctl.ncpu ?? null,
        logical: sysctl.ncpu ?? null,
        pCores: sysctl.pCores ?? null,
        eCores: sysctl.eCores ?? null,
      },
    }
  }

  async function sampleFast(now) {
    const [vmResult, dfDataResult, dfRootResult, netResult, sysctlResult] = await Promise.all([
      run(BIN.vmStat, [], { timeout: 800 }),
      run(BIN.df, ["-k", "/System/Volumes/Data"], { timeout: 800 }),
      run(BIN.df, ["-k", "/"], { timeout: 800 }),
      run(BIN.netstat, ["-ib"], { timeout: 1000 }),
      run(BIN.sysctl, ["vm.loadavg", "vm.swapusage"], { timeout: 800 }),
    ])

    const vm = parseVmStat(vmResult.stdout)
    const totalRam = cache.hardware.totalRam ?? null
    if (vm.pageSize) {
      const used = vm.active + vm.wired + vm.compressed
      const free = vm.free + vm.speculative
      cache.memory = {
        used,
        total: totalRam,
        free,
        available: totalRam ? Math.max(0, totalRam - used) : null,
        cached: vm.fileBacked,
        usedPercent: totalRam ? Math.min(100, (used / totalRam) * 100) : null,
        swapUsed: null,
        swapTotal: null,
      }
    }

    const df = parseDf(dfDataResult.stdout) ?? parseDf(dfRootResult.stdout)
    if (df) {
      const used = df.used ?? (df.total && df.available ? df.total - df.available : null)
      const usedPercent = df.capacity ?? (used && df.available ? (used / (used + df.available)) * 100 : null)
      cache.disk = {
        ...cache.disk,
        mount: df.mount ?? "/",
        total: df.total,
        used,
        free: df.available,
        usedPercent,
      }
    }

    const sysctl = parseSysctl(sysctlResult.stdout)
    if (sysctl.load) {
      cache.cpu = { ...cache.cpu, load1: sysctl.load[0], load5: sysctl.load[1], load15: sysctl.load[2], detail: cache.cpu.detail }
    }
    if (sysctl.swap && sysctl.swap.total != null) {
      cache.memory = { ...cache.memory, swapTotal: sysctl.swap.total, swapUsed: sysctl.swap.used }
    }

    const interfaces = parseNetstatIb(netResult.stdout)
    const name = cache.network.name ?? pickInterface(interfaces)
    if (name && interfaces.has(name)) {
      const link = interfaces.get(name)
      if (Number.isFinite(link.ibytes) && Number.isFinite(link.obytes)) {
        const rx = netDeltas.update(`${name}:rx`, link.ibytes, now)
        const tx = netDeltas.update(`${name}:tx`, link.obytes, now)
        if (rx != null) {
          rxHistory.push(rx)
          txHistory.push(tx ?? 0)
          cache.network = {
            ...cache.network,
            name,
            ip: link.ip ?? cache.network.ip ?? null,
            rxRate: rx / 1e6,
            txRate: (tx ?? 0) / 1e6,
            rxHistory: rxHistory.toArray(),
            txHistory: txHistory.toArray(),
            tunnel: TUNNEL_PATTERN.test(name),
          }
        }
      }
    }
  }

  async function sampleMedium(now) {
    const [pmsetResult, ioregResult, batteryResult] = await Promise.all([
      run(BIN.pmset, ["-g", "batt"], { timeout: 800 }),
      run(BIN.ioreg, ["-c", "IOBlockStorageDriver", "-r", "-d", "1", "-w", "0"], { timeout: 1500 }),
      run(BIN.ioreg, ["-rc", "AppleSmartBattery", "-w0"], { timeout: 1500 }),
    ])

    if (pmsetResult.ok) {
      const battery = parsePmset(pmsetResult.stdout)
      cache.power = {
        ...cache.power,
        present: battery.present,
        percent: battery.percent ?? cache.power.percent ?? null,
        status: battery.status ?? cache.power.status ?? null,
        timeLeft: battery.timeLeft ?? cache.power.timeLeft ?? null,
        source: battery.source ?? null,
      }
    }

    if (batteryResult.ok) {
      const live = parseIoregBattery(batteryResult.stdout)
      cache.power = {
        ...cache.power,
        systemWatts: live.systemWatts ?? cache.power.systemWatts ?? null,
        systemAmps: live.systemAmps ?? cache.power.systemAmps ?? null,
        systemVolts: live.systemVolts ?? cache.power.systemVolts ?? null,
        batteryWatts: live.batteryWatts ?? cache.power.batteryWatts ?? null,
        batteryAmps: live.batteryAmps ?? cache.power.batteryAmps ?? null,
        batteryVolts: live.batteryVolts ?? cache.power.batteryVolts ?? null,
        adapterWatts: live.adapterWatts ?? cache.power.adapterWatts ?? null,
        externalConnected: live.externalConnected ?? cache.power.externalConnected ?? null,
        charging: live.charging ?? cache.power.charging ?? null,
        fullyCharged: live.fullyCharged ?? cache.power.fullyCharged ?? null,
        healthPercent: cache.power.healthPercent ?? live.healthPercent ?? null,
        cycles: cache.power.cycles ?? live.cycles ?? null,
      }
    }

    if (ioregResult.ok) {
      const stats = parseIoregStorageStats(ioregResult.stdout)
      const read = ioDeltas.update("read", stats.bytesRead, now)
      const write = ioDeltas.update("write", stats.bytesWritten, now)
      cache.disk = {
        ...cache.disk,
        readRate: read != null ? toMegabytes(read) : cache.disk.readRate ?? null,
        writeRate: write != null ? toMegabytes(write) : cache.disk.writeRate ?? null,
      }
    }
  }

  async function sampleSlow() {
    const result = await run(BIN.route, ["-n", "get", "default"], { timeout: 800 })
    if (result.ok) {
      const name = parseDefaultRoute(result.stdout)
      if (name) cache.network = { ...cache.network, name }
    }
  }

  return {
    async sample(now) {
      const jobs = []
      if (now >= next.fast) {
        next.fast = now + 1500
        jobs.push(sampleFast(now))
      }
      if (now >= next.medium) {
        next.medium = now + 4500
        jobs.push(sampleMedium(now))
      }
      if (now >= next.slow) {
        next.slow = now + 30_000
        jobs.push(sampleSlow())
      }
      if (now >= next.static) {
        next.static = now + 10 * 60_000
        jobs.push(loadStatic())
      }
      await Promise.allSettled(jobs)
      const hardware = { ...cache.hardware }
      const cpuDetail = buildCpuDetail(cache)
      return {
        platform: "darwin",
        hardware: { ...hardware, diskSize: cache.disk.total ?? null },
        cpu: { ...cache.cpu, detail: cpuDetail },
        memory: { ...cache.memory },
        disk: { ...cache.disk },
        network: { ...cache.network, rxHistory: rxHistory.toArray(), txHistory: txHistory.toArray() },
        power: { ...cache.power },
        errors: [],
      }
    },
    stop() {
      netDeltas.reset()
      ioDeltas.reset()
    },
  }
}

function pickInterface(interfaces) {
  const preferred = ["en0", "en1", "en2", "en3", "en4", "en5"]
  for (const name of preferred) if (interfaces.has(name)) return name
  for (const [name, entry] of interfaces) {
    if (entry.ibytes > 0) return name
  }
  return interfaces.keys().next().value ?? null
}

function buildCpuDetail(cache) {
  if (Number.isFinite(cache.cpu.load1)) {
    const topology =
      cache.cpu.pCores && cache.cpu.eCores ? ` · ${cache.cpu.pCores}P+${cache.cpu.eCores}E` : ""
    return `load ${cache.cpu.load1.toFixed(2)} / ${cache.cpu.load5.toFixed(2)} / ${cache.cpu.load15.toFixed(2)}${topology}`
  }
  if (cache.cpu.logical) return `${cache.cpu.logical} cores`
  return null
}
