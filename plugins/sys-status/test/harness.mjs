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
  toneForUsage,
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
import { buildSidebarModel, lineWidth } from "../src/model.mjs"
import { createDeltaTracker, ema } from "../src/collector/common.mjs"
import { clampInterval, sampleCpu } from "../src/collector/index.mjs"
import {
  cliConfigPath,
  configDirectory,
  parseInstallOptions,
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
    network: { name: sample.net.name, ip: sample.net.ip, gateway: sample.net.gateway, rxRate: 0.02, txRate: 0.01, tunnel: false },
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

test("duration and truncate helpers", () => {
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

test("parseIoregBattery normalizes unsigned 64-bit telemetry", () => {
  const battery = parseIoregBattery(`
    "ExternalConnected" = No
    "Amperage" = 18446744073709550651
    "Voltage" = 12094
    "IsCharging" = No
    "FullyCharged" = No
    "PowerTelemetryData" = {"SystemPowerIn"=0,"SystemCurrentIn"=0,"SystemVoltageIn"=0,"BatteryPower"=18446744073709540941}
  `)
  eq(battery.externalConnected, false)
  eq(battery.systemWatts, 0)
  eq(battery.batteryWatts, 10.675)
  eq(battery.batteryAmps, 0.965)
  eq(battery.batteryVolts, 12.094)
})

test("parseIoregBattery drops implausible telemetry", () => {
  const battery = parseIoregBattery(`
    "Amperage" = 999999999
    "Voltage" = 12094
    "PowerTelemetryData" = {"SystemPowerIn"=0,"SystemCurrentIn"=0,"SystemVoltageIn"=0,"BatteryPower"=999999999}
  `)
  eq(battery.batteryWatts, null)
  eq(battery.batteryAmps, null)
  eq(battery.batteryVolts, 12.094)
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

test("network card lists Up/Down rates as numbers", () => {
  const model = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "rounded", rowSpacing: "compact" })
  const rows = model.lines.map((line) => line.map((segment) => segment.text).join(""))
  const title = rows.findIndex((row) => row.includes("⇅ Network"))
  ok(title > 0, "network card is rendered")
  // Right-aligned in the shared value column; no sparklines.
  eq(rows[title + 1], `│ Up${" ".repeat(24)}0 MB/s │`)
  eq(rows[title + 2], `│ Down${" ".repeat(19)}0.01 MB/s │`)
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

test("full sidebar stacks the dashboard cards", () => {
  const model = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "rounded", rowSpacing: "airy" })
  const text = flatText(model.lines)
  eq(model.lines.length, 27)
  for (const line of model.lines) eq(lineWidth(line), 36)
  for (const needle of [
    "╭─ ◈ System",
    "◉ CPU",
    "Core1",
    "Core4",
    "load 3.41 / 3.62 / 3.80",
    "◫ Memory",
    "Cache 3.2 GB · Avail 5.8 GB",
    "▥ Disk",
    "INTR",
    "I/O",
    "◪ Power",
    "Health",
    "Input",
    "Battery",
    "Adapter",
    "⇅ Network",
    "╰",
  ]) {
    includes(text, needle)
  }
  excludes(text, "4P+4E")
  excludes(text, "Process")
  excludes(text, "…")
  excludes(text, "Excellent")
  excludes(text, "MacBook Air")
  excludes(text, "up 14d")
  const rowText = model.lines.map((line) => flatText([line]))
  const cpuRow = rowText.find((line) => line.includes("Total") && /[█░]/.test(line))
  ok(cpuRow?.endsWith("29.1% │"), `full sidebar values must be right-aligned: ${cpuRow}`)
  eq((cpuRow.match(/[█░]/g) ?? []).length, 19)
  const healthRow = rowText.find((line) => line.includes("Health") && /[█░]/.test(line))
  eq((healthRow.match(/[█░]/g) ?? []).length, 18)
  const cpuTitle = rowText.find((line) => line.includes("◉ CPU"))
  ok(cpuTitle?.startsWith("│ ◉ CPU "), `CPU title must lead with ◉ CPU: ${cpuTitle}`)
  ok(cpuTitle?.endsWith("Apple M1 · 2.4 GHz │"), `CPU chip must be right-aligned: ${cpuTitle}`)
  eq(lineWidth(model.lines[rowText.indexOf(cpuTitle)]), 36)
  const memTitle = rowText.find((line) => line.includes("◫ Memory"))
  ok(memTitle?.endsWith("10.2 GB / 16.0 GB │"), `memory title must show used / total: ${memTitle}`)
  excludes(text, "Free")
  excludes(text, "Total  10.2 GB / 16.0 GB")
  const diskTitle = rowText.find((line) => line.includes("▥ Disk"))
  ok(diskTitle?.endsWith("147.3 GB / 228.3 GB │"), `disk title must show used / total: ${diskTitle}`)
  excludes(text, "Total  228.3 GB")
  excludes(text, "147G used")
  const powerTitle = rowText.find((line) => line.includes("◪ Power"))
  ok(powerTitle?.endsWith("100% │"), `power level must be right-aligned: ${powerTitle}`)
  excludes(text, "Level")
  const netTitle = rowText.find((line) => line.includes("⇅ Network"))
  ok(netTitle?.endsWith("192.0.2.10 │"), `network ip must be right-aligned: ${netTitle}`)
  excludes(text, "en0")
  const barLines = model.lines.filter((line) => line.some((segment) => /[█░]/.test(segment.text)))
  ok(barLines.length >= 8, `expected the full dashboard meters, got ${barLines.length}`)
})

test("full sidebar cores option lists summary or all cores", () => {
  const summary = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "none", rowSpacing: "airy", cores: "p" })
  const all = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "none", rowSpacing: "airy", cores: "all" })
  includes(flatText(summary.lines), "Core4")
  excludes(flatText(summary.lines), "Core5")
  includes(flatText(all.lines), "Core8")
  ok(all.lines.length > summary.lines.length)
  for (const line of all.lines) ok(lineWidth(line) <= 36, `full sidebar line too wide: ${lineWidth(line)}`)
  const cpuRow = summary.lines.map((line) => flatText([line])).find((line) => line.includes("Total") && /[█░]/.test(line))
  eq((cpuRow.match(/[█░]/g) ?? []).length, 23)
  const cpuTitle = summary.lines.map((line) => flatText([line])).find((line) => line.includes("◉ CPU"))
  ok(cpuTitle?.endsWith("Apple M1 · 2.4 GHz"), `unframed CPU chip must end the line: ${cpuTitle}`)
})

test("full sidebar rowSpacing controls the card gaps", () => {
  const base = { width: 36, mode: "full", frame: "none" }
  const compact = buildSidebarModel(macSnapshot(), { ...base, rowSpacing: "compact" })
  const normal = buildSidebarModel(macSnapshot(), { ...base, rowSpacing: "normal" })
  const airy = buildSidebarModel(macSnapshot(), { ...base, rowSpacing: "airy" })
  eq(normal.lines.length, compact.lines.length + 4)
  eq(airy.lines.length, compact.lines.length + 4)
  eq(normal.lines.filter((line) => flatText([line]).trim() === "").length, 4)
  eq(airy.lines.filter((line) => /^─+$/.test(flatText([line]))).length, 4)
  const fallback = buildSidebarModel(macSnapshot(), { ...base, spacing: "airy" })
  eq(flatText(fallback.lines), flatText(airy.lines))
  const bogus = buildSidebarModel(macSnapshot(), { ...base, rowSpacing: "bogus", spacing: "compact" })
  eq(flatText(bogus.lines), flatText(compact.lines))
})

test("full sidebar follows the frame option", () => {
  const rounded = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "rounded", rowSpacing: "airy" })
  includes(flatText([rounded.lines[0]]), "╭")
  includes(flatText([rounded.lines.at(-1)]), "╯")
  for (const line of rounded.lines) eq(lineWidth(line), 36)
  for (const line of rounded.lines.slice(1, -1)) includes(flatText([line]), "│")

  const heavy = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "heavy", rowSpacing: "airy" })
  includes(flatText([heavy.lines[0]]), "┏")
  includes(flatText([heavy.lines.at(-1)]), "┛")

  const plain = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "none", rowSpacing: "airy" })
  excludes(flatText(plain.lines), "╭")
  ok(plain.lines.length < rounded.lines.length, "unframed full sidebar should be shorter")
  eq(lineWidth(plain.lines[0]), 36)
  includes(flatText(plain.lines), "Apple M1 · 2.4 GHz")
})

test("full sidebar keeps mole/solid bars and placeholder states", () => {
  const mole = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "none", barStyle: "mole" })
  const solid = buildSidebarModel(macSnapshot(), { width: 36, mode: "full", frame: "none", barStyle: "solid" })
  includes(flatText(mole.lines), "░")
  excludes(flatText(solid.lines), "░")

  const starting = buildSidebarModel(null, { width: 36, mode: "full" })
  includes(flatText(starting.lines), "starting")
  const unsupported = buildSidebarModel({ unsupported: true, updatedAt: 1, platform: "linux" }, { width: 36, mode: "full" })
  includes(flatText(unsupported.lines), "macOS / Windows only")
})

test("full sidebar works for a Windows snapshot", () => {
  const model = buildSidebarModel(winSnapshot(), { width: 36, mode: "full", frame: "none", rowSpacing: "airy" })
  const text = flatText(model.lines)
  includes(text, "11th Gen Intel")
  for (const line of model.lines) ok(lineWidth(line) <= 36, `Windows full sidebar line too wide: ${lineWidth(line)}`)
  const cpuTitle = model.lines.map((line) => flatText([line])).find((line) => line.includes("◉ CPU"))
  ok(cpuTitle?.startsWith("◉ CPU "), `CPU title must lead with ◉ CPU: ${cpuTitle}`)
  includes(cpuTitle, "…")
  const titleFor = (icon) => model.lines.map((line) => flatText([line])).find((line) => line.includes(icon))
  ok(titleFor("◫ Memory")?.endsWith("19.9 GB / 31.9 GB"), "Windows memory used / total")
  ok(titleFor("▥ Disk")?.endsWith("476.9 GB / 953.9 GB"), "Windows disk used / total")
  ok(titleFor("◪ Power")?.endsWith("87%"), "Windows battery level")
  excludes(text, "Level")
  ok(titleFor("⇅ Network")?.endsWith("192.0.2.20"), "Windows network ip")
  excludes(text, "Ethernet")
  excludes(text, "Process")
})

test("battery shows the discharge draw instead of wrapped u64 values", () => {
  const snapshot = macSnapshot()
  snapshot.power = {
    ...snapshot.power,
    percent: 91,
    status: "Discharging",
    externalConnected: false,
    charging: false,
    fullyCharged: false,
    systemWatts: 0,
    systemAmps: 0,
    systemVolts: 0,
    batteryWatts: 10.675,
    batteryAmps: 0.965,
    batteryVolts: 12.094,
    adapterWatts: null,
    acWatts: null,
    cycles: 259,
  }
  const full = buildSidebarModel(snapshot, { width: 36, mode: "full", frame: "none", rowSpacing: "airy" })
  const text = flatText(full.lines)
  includes(text, "Battery")
  includes(text, "10.7W")
  includes(text, "Cycles")
  includes(text, "259")
  excludes(text, "Input")
  excludes(text, "Adapter")
  excludes(text, "18446744073709540")

  const compact = buildSidebarModel(snapshot, { width: 36, frame: "none", spacing: "compact" })
  const compactText = flatText(compact.lines)
  includes(compactText, "PWR")
  includes(compactText, "10.7W")
  excludes(compactText, "18446744073709540")
})

test("usage tones: below 50 green, 50-79 orange, 80+ red", () => {
  eq(toneForUsage(0), "success")
  eq(toneForUsage(49.9), "success")
  eq(toneForUsage(50), "warning")
  eq(toneForUsage(79.9), "warning")
  eq(toneForUsage(80), "error")
  eq(toneForUsage(100), "error")
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
})

test("unsupported platforms render a friendly message", () => {
  const model = buildSidebarModel({ unsupported: true, updatedAt: 1, platform: "linux" })
  includes(flatText(model.lines), "macOS / Windows only")
})

// ---------------------------------------------------------------------------
// collector helpers
// ---------------------------------------------------------------------------

test("ema smoothing", () => {
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

test("parseInstallOptions keeps only valid flag values", () => {
  const full = parseInstallOptions([
    "--sidebar-mode", "full",
    "--row-spacing", "airy",
    "--spacing", "normal",
    "--interval", "3",
    "--cores", "all",
    "--placement", "bottom",
    "--bar-style", "solid",
    "--frame", "heavy",
    "--color-mode", "theme",
  ])
  eq(full, {
    interval: 3,
    spacing: "normal",
    rowSpacing: "airy",
    barStyle: "solid",
    frame: "heavy",
    colorMode: "theme",
    sidebarMode: "full",
    cores: "all",
    placement: "bottom",
  })

  eq(parseInstallOptions([]), { interval: 2 })
  eq(parseInstallOptions(["--sidebar-mode", "wide"]), { interval: 2 })
  eq(parseInstallOptions(["--sidebar-mode"]), { interval: 2 })
  eq(parseInstallOptions(["--interval", "0"]), { interval: 2 })
  eq(parseInstallOptions(["--interval", "abc"]), { interval: 2 })
  eq(parseInstallOptions(["--interval", "5"]), { interval: 5 })
  eq(parseInstallOptions(["--cores", "all"]), { interval: 2, cores: "all" })
  eq(parseInstallOptions(["--dry-run", "--frame", "none"]), { interval: 2, frame: "none" })
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
