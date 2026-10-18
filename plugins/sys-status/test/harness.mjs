// sys-status — offline harness.
//
// Pure Node test runner: no OpenTUI, no Solid, no child processes. Run with
// `node test/harness.mjs` (or `bun run test`) and expect:
//
//   ALL TESTS PASSED (N assertions)

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  bar,
  barText,
  formatAmps,
  formatBytes,
  formatBytesShort,
  formatClock,
  formatDuration,
  formatPercent,
  formatRate,
  formatVolts,
  formatWatts,
  sparkline,
  truncate,
} from "../src/format.mjs"
import { computeHealth } from "../src/health.mjs"
import {
  batteryStatusLabel,
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
  parseWin32Hardware,
  parseWin32Sample,
} from "../src/parser.mjs"
import { buildPanelModel, buildSidebarModel, combineColumns, lineWidth } from "../src/model.mjs"
import { createDeltaTracker, createRingBuffer, ema } from "../src/collector/common.mjs"
import { clampInterval, sampleCpu } from "../src/collector/index.mjs"
import {
  cliConfigPath,
  configDirectory,
  patchCliConfig,
  removeCliPlugin,
  sidebarHidden,
} from "../scripts/lib.mjs"
import { MOLE_PALETTE } from "../src/colors.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, "..")
const FIXTURES = path.join(HERE, "fixtures")
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8")

let assertions = 0
let failures = 0

function test(name, fn) {
  try {
    fn()
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}`)
    console.error(`  ${error?.message ?? error}`)
  }
}

function eq(actual, expected, message) {
  assertions += 1
  if (message === undefined) assert.deepStrictEqual(actual, expected)
  else assert.deepStrictEqual(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  if (message === undefined) assert.ok(value)
  else assert.ok(value, message)
}

function includes(text, needle, message) {
  assertions += 1
  assert.ok(String(text).includes(needle), message ?? `expected to include ${needle}`)
}

function excludes(text, needle, message) {
  assertions += 1
  assert.ok(!String(text).includes(needle), message ?? `expected NOT to include ${needle}`)
}

function flatText(lines) {
  return (lines ?? []).map((line) => line.map((segment) => segment.text).join("")).join("\n")
}

function macSnapshot() {
  const vm = parseVmStat(fixture("darwin-vm_stat.txt"))
  const sysctl = parseSysctl(fixture("darwin-sysctl.txt"))
  const df = parseDf(fixture("darwin-df.txt"))
  const profilerPower = parseSystemProfilerPower(fixture("darwin-profiler-power.json"))
  const snapshot = {
    platform: "darwin",
    updatedAt: Date.now(),
    uptimeSec: 14 * 86400 + 16 * 3600,
    hardware: {
      name: "MacBook Air",
      chip: "Apple M1",
      gpuCores: 7,
      totalRam: sysctl.memsize,
      diskSize: df.total,
      osVersion: "macOS 27.0.1",
      refreshRate: 60,
    },
    cpu: {
      usage: 29.1,
      perCore: [44.4, 40.9, 40.4, 39.8, 20.1, 18.2, 15.5, 12.0],
      load1: 3.41,
      load5: 3.62,
      load15: 3.8,
      physical: 8,
      logical: 8,
      pCores: 4,
      eCores: 4,
      speedGhz: 2.4,
      detail: "load 3.41 / 3.62 / 3.80 · 4P+4E",
    },
    memory: {
      used: 10933141504,
      total: sysctl.memsize,
      free: vm.free + vm.speculative,
      available: sysctl.memsize - 10933141504,
      cached: vm.fileBacked,
      usedPercent: 63.6,
      swapUsed: 0,
      swapTotal: 0,
    },
    disk: {
      mount: df.mount,
      total: df.total,
      used: df.used,
      free: df.available,
      usedPercent: df.capacity,
      readRate: 0.4,
      writeRate: 1.7,
    },
    power: {
      present: true,
      percent: 100,
      status: "Charged",
      healthPercent: profilerPower.healthPercent,
      healthLabel: profilerPower.health,
      cycles: profilerPower.cycles,
      acWatts: 57,
      adapterWatts: 57,
      systemWatts: 10.618,
      systemAmps: 0.523,
      systemVolts: 20.27,
      batteryWatts: 0,
      batteryAmps: 0,
      batteryVolts: 12.748,
      externalConnected: true,
      charging: false,
      fullyCharged: true,
      timeLeft: "0:00",
    },
    network: {
      name: "en0",
      ip: "192.0.2.10",
      rxRate: 0.01,
      txRate: 0,
      rxHistory: [0, 0.01, 0.02, 0.005, 0.03],
      txHistory: [0, 0, 0.01],
      tunnel: false,
    },
    health: {},
    errors: [],
  }
  snapshot.health = computeHealth(snapshot)
  return snapshot
}

function winSnapshot() {
  const sample = parseWin32Sample(fixture("win32-sample.json"))
  const hardware = parseWin32Hardware(fixture("win32-hardware.json"))
  const snapshot = {
    platform: "win32",
    updatedAt: Date.now(),
    uptimeSec: 3 * 86400 + 3600,
    hardware: {
      name: hardware.name,
      chip: hardware.chip,
      totalRam: hardware.ram,
      diskSize: sample.disk.total,
      osVersion: hardware.osVersion,
      refreshRate: hardware.refreshRate,
      gpuName: hardware.gpu,
      logical: hardware.logical,
      speedGhz: hardware.speedGhz,
    },
    cpu: { usage: 18.2, perCore: [20, 15, 30, 10, 12, 8, 40, 25], physical: hardware.cores, logical: hardware.logical, speedGhz: hardware.speedGhz, detail: `${hardware.logical} cores · ${hardware.speedGhz} GHz` },
    memory: {
      used: sample.memory.total - sample.memory.free,
      total: sample.memory.total,
      free: sample.memory.free,
      available: sample.memory.available,
      cached: sample.memory.cache,
      usedPercent: ((sample.memory.total - sample.memory.free) / sample.memory.total) * 100,
      swapUsed: sample.pageFile.used,
      swapTotal: sample.pageFile.total,
    },
    disk: { mount: sample.disk.name, total: sample.disk.total, used: sample.disk.total - sample.disk.free, free: sample.disk.free, usedPercent: ((sample.disk.total - sample.disk.free) / sample.disk.total) * 100, readRate: sample.io.readRate, writeRate: sample.io.writeRate },
    power: { present: true, percent: sample.battery.percent, status: sample.battery.status, healthPercent: sample.battery.healthPercent, healthLabel: "Good", cycles: null, acWatts: null, timeLeft: "3:30" },
    network: { name: sample.net.name, ip: sample.net.ip, gateway: sample.net.gateway, rxRate: 0.02, txRate: 0.01, rxHistory: [0.01, 0.02, 0.03], txHistory: [0, 0.01], tunnel: false },
    health: {},
    errors: [],
  }
  snapshot.health = computeHealth(snapshot)
  return snapshot
}

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

test("formatBytes uses binary units with a GB label", () => {
  eq(formatBytes(17179869184), "16.0 GB")
  eq(formatBytes(245107195904), "228.3 GB")
  eq(formatBytes(512), "512 B")
  eq(formatBytes(null), "--")
})

test("formatBytesShort compacts large values", () => {
  eq(formatBytesShort(154404844 * 1024), "147G")
  eq(formatBytesShort(512 * 1024 * 1024), "512M")
  eq(formatBytesShort(0), "0B")
})

test("formatPercent and formatRate", () => {
  eq(formatPercent(63.639), "63.6%")
  eq(formatPercent(100), "100%")
  eq(formatPercent(73), "73%")
  eq(formatPercent(null), "--")
  eq(formatRate(0.01), "0.01 MB/s")
  eq(formatRate(0.001), "0 MB/s")
  eq(formatRate(1.234), "1.2 MB/s")
  eq(formatRate(39.22), "39 MB/s")
  eq(formatRate(null), "--")
})

test("power formatting", () => {
  eq(formatWatts(10.618, 1), "10.6W")
  eq(formatWatts(57, 0), "57W")
  eq(formatWatts(null), null)
  eq(formatAmps(0.523), "0.52A")
  eq(formatAmps(null), null)
  eq(formatVolts(20.27), "20.3V")
  eq(formatVolts(null), null)
  eq(formatClock(new Date(2026, 0, 1, 21, 24, 5).getTime()), "21:24:05")
  eq(formatClock(0), null)
  eq(formatClock(null), null)
})

test("bars render fixed widths", () => {
  eq(bar(29.1, 10).text.length, 10)
  eq(bar(29.1, 10).filled.length, 2)
  eq(bar(99.9, 10).filled.length, 9)
  eq(bar(0, 10).filled.length, 0)
  eq(bar(100, 10).filled.length, 10)
  eq(barText(0, 10), "░".repeat(10))
})

test("sparkline and duration helpers", () => {
  eq([...sparkline([1, 2, 3], 3)], ["▃", "▅", "█"])
  eq(sparkline([], 3), "▁▁▁")
  eq(formatDuration(14 * 86400 + 16 * 3600), "14d 16h")
  eq(formatDuration(90), "1m 30s")
  eq(truncate("MacBook Air", 6), "MacBo…")
})

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test("health is calibrated for a healthy Mac", () => {
  const health = macSnapshot().health
  eq(health.score, 97)
  eq(health.label, "Excellent")
  eq(health.message, "Restart Recommended")
  eq(health.tone, "success")
})

test("health reacts to CPU, disk and battery problems", () => {
  const cpu = macSnapshot()
  cpu.cpu.usage = 95
  const cpuHealth = computeHealth(cpu)
  eq(cpuHealth.message, "High CPU")
  ok(cpuHealth.score < 97)

  const disk = macSnapshot()
  disk.disk.usedPercent = 95
  eq(computeHealth(disk).message, "Disk Almost Full")

  const battery = macSnapshot()
  battery.power.healthPercent = 60
  eq(computeHealth(battery).message, "Service Battery")

  const fresh = macSnapshot()
  fresh.uptimeSec = 3600
  eq(computeHealth(fresh).message, "All systems normal")
})

// ---------------------------------------------------------------------------
// macOS parsers
// ---------------------------------------------------------------------------

test("parseVmStat", () => {
  const vm = parseVmStat(fixture("darwin-vm_stat.txt"))
  eq(vm.pageSize, 16384)
  eq(vm.active, 366667 * 16384)
  eq(vm.compressed, 135760 * 16384)
  eq(vm.fileBacked, 210803 * 16384)
  ok(vm.free > 0)
})

test("parseSysctl", () => {
  const sysctl = parseSysctl(fixture("darwin-sysctl.txt"))
  eq(sysctl.model, "MacBookAir10,1")
  eq(sysctl.chip, "Apple M1")
  eq(sysctl.memsize, 17179869184)
  eq(sysctl.pCores, 4)
  eq(sysctl.eCores, 4)
  eq(sysctl.load, [3.88, 3.14, 3.27])
  eq(sysctl.swap.total, 0)
})

test("parseDf", () => {
  const df = parseDf(fixture("darwin-df.txt"))
  eq(df.total, 239362496 * 1024)
  eq(df.used, 154404844 * 1024)
  eq(df.available, 59325244 * 1024)
  eq(df.capacity, 73)
  eq(df.mount, "/System/Volumes/Data")
})

test("parseNetstatIb keeps link counters and IPv4 addresses", () => {
  const interfaces = parseNetstatIb(fixture("darwin-netstat.txt"))
  eq(interfaces.get("en0").ibytes, 16048201590)
  eq(interfaces.get("en0").obytes, 3514240914)
  eq(interfaces.get("en0").ip, "192.0.2.10")
  eq(interfaces.get("utun3").ip, "10.0.0.2")
  eq(interfaces.get("lo0").obytes, 872170679)
})

test("parseDefaultRoute / parsePmset", () => {
  eq(parseDefaultRoute("gateway: 192.0.2.1\n  interface: en0\n"), "en0")
  const battery = parsePmset(fixture("darwin-pmset.txt"))
  eq(battery.present, true)
  eq(battery.percent, 100)
  eq(battery.status, "Charged")
  eq(battery.timeLeft, "0:00")
})

test("parseIoregStorageStats / parseIoregBattery", () => {
  const io = parseIoregStorageStats(fixture("darwin-ioreg-storage.txt"))
  eq(io.bytesRead, 149394935808)
  eq(io.bytesWritten, 182376898560)
  const battery = parseIoregBattery(fixture("darwin-ioreg-battery.txt"))
  eq(battery.cycles, 259)
  eq(battery.healthPercent, 83.2)
  eq(battery.systemWatts, 10.618)
  eq(battery.systemAmps, 0.523)
  eq(battery.systemVolts, 20.27)
  eq(battery.batteryWatts, 0)
  eq(battery.batteryAmps, 0)
  eq(battery.batteryVolts, 12.748)
  eq(battery.adapterWatts, 57)
  eq(battery.externalConnected, true)
  eq(battery.charging, false)
  eq(battery.fullyCharged, true)
})

test("parseIoregBattery reads discharging power", () => {
  const battery = parseIoregBattery(`
    "AdapterDetails" = {"IsWireless"=No,"Watts"=57}
    "ExternalConnected" = No
    "Amperage" = -980
    "Voltage" = 12600
    "IsCharging" = No
    "FullyCharged" = No
    "PowerTelemetryData" = {"SystemPowerIn"=0,"SystemCurrentIn"=0,"SystemVoltageIn"=0,"BatteryPower"=12400}
  `)
  eq(battery.externalConnected, false)
  eq(battery.systemWatts, 0)
  eq(battery.batteryWatts, 12.4)
  eq(battery.batteryAmps, 0.98)
  eq(battery.batteryVolts, 12.6)
  eq(battery.adapterWatts, 57)
})

test("system_profiler parsers", () => {
  eq(parseSystemProfilerHardware(fixture("darwin-profiler-hardware.json")).name, "MacBook Air")
  eq(parseSystemProfilerDisplays(fixture("darwin-profiler-displays.json")).gpuCores, 7)
  const power = parseSystemProfilerPower(fixture("darwin-profiler-power.json"))
  eq(power.healthPercent, 88)
  eq(power.health, "Good")
  eq(power.cycles, 259)
  eq(power.acWatts, 57)
})

// ---------------------------------------------------------------------------
// Windows parsers
// ---------------------------------------------------------------------------

test("parseWin32Sample", () => {
  const sample = parseWin32Sample(fixture("win32-sample.json"))
  eq(sample.memory.total, 33402856 * 1024)
  eq(sample.disk.total, 1024209543168)
  eq(sample.io.readRate, 0.4)
  eq(sample.net.ip, "192.0.2.20")
  eq(sample.battery.status, "Discharging")
  eq(sample.battery.healthPercent, 80)
  eq(sample.pageFile.total, 8192 * 1024 * 1024)
})

test("parseWin32Hardware", () => {
  const hardware = parseWin32Hardware(fixture("win32-hardware.json"))
  eq(hardware.name, "LENOVO 20XW004AUS")
  eq(hardware.osVersion, "Windows 11 Pro")
  eq(hardware.speedGhz, 3)
  eq(hardware.refreshRate, 60)
  eq(batteryStatusLabel(2), "AC Power")
})

test("invalid input degrades to null/zero", () => {
  eq(parseWin32Sample("not json"), null)
  eq(parseDf(""), null)
  eq(parseVmStat("").pageSize, 4096)
})

test("win32 parsers keep missing values null", () => {
  const sample = parseWin32Sample(
    '{"memory":{"availableMB":null,"cacheBytes":null},"disk":{"total":null,"free":null},"io":{"readBytesPerSec":null},"net":{},"battery":{"present":false},"pageFile":{"totalMB":null}}',
  )
  eq(sample.memory.available, null)
  eq(sample.memory.cache, null)
  eq(sample.disk.total, null)
  eq(sample.io.readRate, null)
  eq(sample.pageFile.total, null)
  const hardware = parseWin32Hardware('{"manufacturer":"LENOVO","model":"X1","speed":null,"cores":null,"ram":null,"refresh":null}')
  eq(hardware.speedGhz, null)
  eq(hardware.cores, null)
  eq(hardware.ram, null)
})

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

test("sidebar model fits and has no processes", () => {
  const model = buildSidebarModel(macSnapshot(), { width: 36, frame: "none" })
  const text = flatText(model.lines)
  for (const label of ["CPU", "RAM", "DSK", "NET", "PWR", "● 97", "CPU Apple M1 · 2.4 GHz", "16.0 GB", "10.6W"]) includes(text, label)
  excludes(text, "100%")
  excludes(text, "Process")
  for (const line of model.lines) ok(lineWidth(line) <= 36, `sidebar line too wide: ${lineWidth(line)}`)
  const barLines = model.lines.filter((line) => line.some((segment) => /[█░]/.test(segment.text)))
  ok(barLines.length >= 4, "expected four full-width sidebar bars")
  for (const line of barLines) eq(lineWidth(line), 36)
  const pwrIndex = model.lines.findIndex((line) => line.some((segment) => segment.text.includes("PWR")))
  const netIndex = model.lines.findIndex((line) => line.some((segment) => segment.text.includes("NET")))
  ok(pwrIndex >= 0 && netIndex >= 0 && pwrIndex < netIndex, "PWR must appear before NET")
})

test("sidebar spacing modes are progressively taller", () => {
  const compact = buildSidebarModel(macSnapshot(), { width: 36, spacing: "compact", frame: "none" })
  const normal = buildSidebarModel(macSnapshot(), { width: 36, spacing: "normal", frame: "none" })
  const airy = buildSidebarModel(macSnapshot(), { width: 36, spacing: "airy", frame: "none" })
  ok(compact.lines.length < normal.lines.length)
  ok(normal.lines.length < airy.lines.length)
})

test("Mole palette matches the reference", () => {
  eq(MOLE_PALETTE.success, [165, 214, 167])
  eq(MOLE_PALETTE.warning, [255, 169, 77])
  eq(MOLE_PALETTE.error, [255, 95, 95])
  eq(MOLE_PALETTE.accent, [199, 159, 215])
  eq(MOLE_PALETTE.border, [64, 64, 64])
  eq(MOLE_PALETTE.muted, [115, 115, 115])
})

test("sidebar network shows zero rates instead of idle", () => {
  const snapshot = macSnapshot()
  snapshot.network.rxRate = 0
  snapshot.network.txRate = 0
  const model = buildSidebarModel(snapshot, { width: 36, frame: "none" })
  includes(flatText(model.lines), "↓ 0 MB/s  ↑ 0 MB/s")
  excludes(flatText(model.lines), "idle")
})

test("sidebar frame mirrors go-usage", () => {
  const framed = buildSidebarModel(macSnapshot(), { width: 36, frame: "rounded", spacing: "compact" })
  const top = flatText([framed.lines[0]])
  includes(top, "╭")
  includes(top, "◈ System")
  ok(!/\d{2}:\d{2}:\d{2}/.test(top), "top border should not include the clock")
  const bottom = flatText([framed.lines.at(-1)])
  includes(bottom, "╰")
  includes(bottom, "╯")
  for (const line of framed.lines) eq(lineWidth(line), 36)
  for (const line of framed.lines.slice(1, -1)) includes(flatText([line]), "│")

  const heavy = buildSidebarModel(macSnapshot(), { width: 36, frame: "heavy", spacing: "compact" })
  includes(flatText([heavy.lines[0]]), "┏")
  includes(flatText([heavy.lines.at(-1)]), "┛")

  const plain = buildSidebarModel(macSnapshot(), { width: 36, frame: "none", spacing: "compact" })
  excludes(flatText(plain.lines), "╭")
  eq(lineWidth(plain.lines[0]), 36)
})

test("panel model uses two columns on wide terminals", () => {
  const model = buildPanelModel(macSnapshot(), { width: 120, cores: "p" })
  eq(model.twoColumn, true)
  ok(model.columnWidth >= 48)
  const header = flatText(model.header)
  includes(header, "Status")
  includes(header, "Health")
  includes(header, "● 97")
  includes(header, "Excellent")
  includes(flatText(model.left), "CPU")
  includes(flatText(model.left), "Disk")
  includes(flatText(model.right), "Memory")
  includes(flatText(model.right), "Power")
  includes(flatText(model.right), "Input")
  includes(flatText(model.right), "10.6W")
  includes(flatText(model.right), "0.52A")
  includes(flatText(model.right), "20.3V")
  includes(flatText(model.right), "Battery")
  includes(flatText(model.right), "57W max")
  includes(flatText(model.full), "Network")
  includes(flatText(model.full), "Down")
  includes(flatText(model.footer), "fullscreen")
  excludes(flatText([...model.header, ...model.left, ...model.right, ...model.full, ...model.footer]), "Process")
})

test("panel model collapses to one column when narrow", () => {
  const model = buildPanelModel(macSnapshot(), { width: 80, cores: "p" })
  eq(model.twoColumn, false)
  eq(model.columnWidth, 76)
})

test("mole bar style uses a colored track; solid uses spaces", () => {
  const mole = buildSidebarModel(macSnapshot(), { width: 36, spacing: "airy", barStyle: "mole", frame: "none" })
  const solid = buildSidebarModel(macSnapshot(), { width: 36, spacing: "airy", barStyle: "solid", frame: "none" })
  includes(flatText(mole.lines), "░")
  excludes(flatText(solid.lines), "░")

  const cpuLine = mole.lines.find(
    (line) => line.some((segment) => segment.text.includes("CPU")) && line.some((segment) => segment.tone === "success"),
  )
  ok(cpuLine, "CPU 29% should be green")
  const memLine = mole.lines.find((line) => line.some((segment) => segment.text.includes("RAM")))
  ok(memLine?.some((segment) => segment.tone === "warning"), "memory 63% should be orange")
  const diskLine = mole.lines.find((line) => line.some((segment) => segment.text.includes("DSK")))
  ok(diskLine?.some((segment) => segment.tone === "warning"), "disk 73% should be orange")
  const powerLine = mole.lines.find((line) => line.some((segment) => segment.text.includes("PWR")))
  ok(powerLine?.some((segment) => segment.tone === "success"), "battery 100% should be green")

  const panelMole = buildPanelModel(macSnapshot(), { width: 120, barStyle: "mole" })
  includes(flatText([...panelMole.left, ...panelMole.right]), "░")
  const panelSolid = buildPanelModel(macSnapshot(), { width: 120, barStyle: "solid" })
  excludes(flatText([...panelSolid.left, ...panelSolid.right]), "░")
})

test("panel model works for a Windows snapshot", () => {
  const model = buildPanelModel(winSnapshot(), { width: 120 })
  const text = flatText([...model.header, ...model.left, ...model.right, ...model.full])
  includes(text, "LENOVO 20XW004AUS")
  includes(text, "Windows 11 Pro")
  includes(text, "Ethernet")
  excludes(text, "Process")
})

test("combineColumns pads the left column", () => {
  const left = [[{ text: "a", tone: "base" }]]
  const right = [[{ text: "b", tone: "base" }]]
  const rows = combineColumns(left, right, 10, 3)
  eq(rows.length, 1)
  eq(lineWidth(rows[0]), 14)
})

test("unsupported platforms render a friendly message", () => {
  const model = buildSidebarModel({ unsupported: true, updatedAt: 1, platform: "linux" })
  includes(flatText(model.lines), "macOS / Windows only")
})

// ---------------------------------------------------------------------------
// collector helpers
// ---------------------------------------------------------------------------

test("ring buffer and ema", () => {
  const buffer = createRingBuffer(3)
  for (const value of [1, 2, 3, 4, 5]) buffer.push(value)
  eq(buffer.toArray(), [3, 4, 5])
  eq(ema(10, 20, 0.5), 15)
  eq(ema(null, 20, 0.5), 20)
})

test("delta tracker computes per-second rates", () => {
  const tracker = createDeltaTracker()
  eq(tracker.update("rx", 100, 1000), null)
  eq(tracker.update("rx", 120, 2000), 20)
  eq(tracker.update("rx", 110, 3000), 0)
})

test("sampleCpu floors the denominator at the wall clock", () => {
  const before = [{ times: { user: 100, nice: 0, sys: 100, irq: 0, idle: 800 } }]
  const after = [{ times: { user: 200, nice: 0, sys: 200, irq: 0, idle: 1600 } }]
  const result = sampleCpu(before, after, 1000)
  eq(result.perCore, [20])
  eq(result.usage, 20)
})

test("clampInterval keeps sane bounds", () => {
  eq(clampInterval(undefined), 2000)
  eq(clampInterval(500), 1000)
  eq(clampInterval(120_000), 10_000)
})

// ---------------------------------------------------------------------------
// install helpers
// ---------------------------------------------------------------------------

test("config paths follow XDG/home", () => {
  eq(configDirectory({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/u"), path.join("/tmp/xdg", "opencode"))
  eq(configDirectory({}, "/home/u"), path.join("/home/u", ".config", "opencode"))
  eq(cliConfigPath({}, "/home/u"), path.join("/home/u", ".config", "opencode", "cli.json"))
  eq(sidebarHidden({ session: { sidebar: "hide" } }), true)
  eq(sidebarHidden({ session: { sidebar: "auto" } }), false)
})

test("patchCliConfig adds, preserves and updates entries", () => {
  const url = "file:///tmp/oc-plugins/plugins/sys-status"
  const fresh = patchCliConfig('{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n', url, { options: { interval: 2 } })
  eq(fresh.config.plugins.length, 1)
  eq(fresh.config.plugins[0].package, url)
  eq(fresh.config.plugins[0].options.interval, 2)

  const existing = patchCliConfig(
    JSON.stringify({ plugins: ["opencode.example", { package: "file:///tmp/other" }] }),
    url,
    { options: { interval: 3 } },
  )
  eq(existing.config.plugins.length, 3)
  eq(existing.config.plugins[0], "opencode.example")

  const updated = patchCliConfig(existing.text, url, { options: { interval: 5, spacing: "compact" } })
  eq(updated.config.plugins.length, 3)
  eq(updated.config.plugins[2].options.interval, 5)
  eq(updated.config.plugins[2].options.spacing, "compact")
  eq(updated.existed, true)

  const merged = patchCliConfig(updated.text, url, { options: { interval: 7 } })
  eq(merged.config.plugins[2].options.spacing, "compact")
  eq(merged.config.plugins[2].options.interval, 7)

  const removed = removeCliPlugin(updated.text, url)
  eq(removed.removed, true)
  eq(removed.config.plugins.length, 2)
})

// ---------------------------------------------------------------------------
// no external dependency on Mole
// ---------------------------------------------------------------------------

function listFiles(directory) {
  const output = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...listFiles(full))
    else output.push(full)
  }
  return output
}

test("runtime sources never depend on the Mole CLI", () => {
  const files = [
    path.join(PLUGIN_DIR, "tui.ts"),
    ...listFiles(path.join(PLUGIN_DIR, "src")),
    ...listFiles(path.join(PLUGIN_DIR, "scripts")),
  ].filter((file) => /\.(mjs|ts|tsx)$/.test(file))
  const pattern = /MOLE_BIN|MOLE_STATUS_BIN|mo status --watch|brew install mole/i
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8")
    ok(!pattern.test(text), `${path.relative(PLUGIN_DIR, file)} references Mole as a runtime dependency`)
  }
})

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log(`ALL TESTS PASSED (${assertions} assertions)`)
