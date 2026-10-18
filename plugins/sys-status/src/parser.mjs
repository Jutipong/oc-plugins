// sys-status — command output parsers.
//
// Pure functions only: no child processes, no filesystem, no platform checks.
// The offline harness feeds fixtures straight into these so both macOS and
// Windows parsing can be tested on either machine.

import { hasNumber, normalizeKey } from "./format.mjs"

function linesOf(text) {
  return String(text ?? "").split(/\r?\n/)
}

function parseSizeToken(token) {
  if (token == null) return null
  const match = String(token)
    .trim()
    .match(/^([\d.]+)\s*([KMGT]?)B?$/i)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = (match[2] || "").toUpperCase()
  const factor = unit === "T" ? 1024 ** 4 : unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1
  return value * factor
}

function parseJsonLoose(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

function firstArrayItem(value) {
  if (Array.isArray(value)) return value[0]
  return value ?? null
}

/** Number coercion that keeps missing values as null instead of 0. */
function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

export function parseVmStat(text) {
  const result = {
    pageSize: 4096,
    free: 0,
    active: 0,
    inactive: 0,
    speculative: 0,
    wired: 0,
    compressed: 0,
    fileBacked: 0,
    purgeable: 0,
  }
  const labelMap = {
    "pages free": "free",
    "pages active": "active",
    "pages inactive": "inactive",
    "pages speculative": "speculative",
    "pages wired down": "wired",
    "pages occupied by compressor": "compressed",
    "file-backed pages": "fileBacked",
    "pages purgeable": "purgeable",
  }
  let first = true
  for (const line of linesOf(text)) {
    if (first) {
      first = false
      const pageMatch = line.match(/page size of (\d+) bytes/i)
      if (pageMatch) result.pageSize = Number(pageMatch[1])
    }
    const match = line.match(/^"?([^":]+)"?:\s+(\d+)\.?\s*$/)
    if (!match) continue
    const key = labelMap[normalizeKey(match[1])]
    if (!key) continue
    result[key] = Number(match[2]) * result.pageSize
  }
  return result
}

export function parseSysctl(text) {
  const map = {}
  for (const line of linesOf(text)) {
    const match = line.match(/^([^:]+):\s*(.*)$/)
    if (!match) continue
    map[match[1].trim()] = match[2].trim()
  }
  const loadRaw = map["vm.loadavg"] ?? ""
  const loadMatch = loadRaw.match(/\{?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  const swapRaw = map["vm.swapusage"] ?? ""
  const swapTotal = swapRaw.match(/total = ([\d.]+\s*[KMGT]?)/i)
  const swapUsed = swapRaw.match(/used = ([\d.]+\s*[KMGT]?)/i)
  const swapFree = swapRaw.match(/free = ([\d.]+\s*[KMGT]?)/i)
  return {
    model: map["hw.model"] ?? null,
    chip: map["machdep.cpu.brand_string"] ?? null,
    memsize: Number(map["hw.memsize"]) || null,
    ncpu: Number(map["hw.ncpu"]) || null,
    pCores: Number(map["hw.perflevel0.physicalcpu"]) || null,
    eCores: Number(map["hw.perflevel1.physicalcpu"]) || null,
    osVersion: map["kern.osproductversion"] ?? null,
    arch: map["hw.optional.arm64"] === "1" ? "arm64" : null,
    load: loadMatch ? [Number(loadMatch[1]), Number(loadMatch[2]), Number(loadMatch[3])] : null,
    swap: {
      total: swapTotal ? parseSizeToken(swapTotal[1]) : null,
      used: swapUsed ? parseSizeToken(swapUsed[1]) : null,
      free: swapFree ? parseSizeToken(swapFree[1]) : null,
    },
  }
}

export function parseDf(text) {
  const rows = linesOf(text).filter((line) => line.trim().length > 0)
  const row = rows[rows.length - 1]
  if (!row || /^Filesystem\b/i.test(row.trim())) {
    const dataRow = rows.find((line) => line.trim() && !/^Filesystem\b/i.test(line.trim()))
    if (!dataRow) return null
    return parseDfRow(dataRow)
  }
  return parseDfRow(row)
}

function parseDfRow(row) {
  const fields = row.trim().split(/\s+/)
  if (fields.length < 5) return null
  const blocks = Number(fields[1])
  const used = Number(fields[2])
  const available = Number(fields[3])
  const capacity = Number(String(fields[4]).replace("%", ""))
  const mount = fields.slice(8).join(" ") || fields[8] || null
  if (!Number.isFinite(blocks)) return null
  return {
    filesystem: fields[0],
    total: blocks * 1024,
    used: Number.isFinite(used) ? used * 1024 : null,
    available: Number.isFinite(available) ? available * 1024 : null,
    capacity: Number.isFinite(capacity) ? capacity : null,
    mount,
  }
}

export function parseNetstatIb(text) {
  const byName = new Map()
  for (const line of linesOf(text)) {
    const trimmed = line.trim()
    if (!trimmed || /^Name\b/.test(trimmed)) continue
    const fields = trimmed.split(/\s+/)
    if (fields.length < 6) continue
    const name = fields[0]
    const network = fields[2] ?? ""
    if (network.startsWith("<Link#")) {
      const entry = byName.get(name) ?? { name }
      const mac = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(fields[3] ?? "")
      const offset = mac ? 4 : 3
      entry.ibytes = Number(fields[offset + 2])
      entry.obytes = Number(fields[offset + 5])
      entry.ipkts = Number(fields[offset])
      entry.opkts = Number(fields[offset + 3])
      entry.mac = mac ? fields[3] : null
      byName.set(name, entry)
    } else if (/^\d+\.\d+/.test(network) && fields[3] && !fields[3].includes(":")) {
      const entry = byName.get(name) ?? { name }
      if (!entry.ip) entry.ip = fields[3]
      byName.set(name, entry)
    }
  }
  return byName
}

export function parseDefaultRoute(text) {
  const match = String(text ?? "").match(/^\s*interface:\s*(\S+)/m)
  return match ? match[1] : null
}

const PMSET_STATUS = {
  charged: "Charged",
  charging: "Charging",
  discharging: "Discharging",
  "finishing charge": "Finishing",
  "ac attached": "AC Attached",
  "not charging": "Not Charging",
}

export function parsePmset(text) {
  const raw = String(text ?? "")
  const sourceMatch = raw.match(/Now drawing from '([^']+)'/)
  const batteryMatch = raw.match(/(-?\d+)%;\s*([^;]+);\s*([\d:]+)\s+remaining/)
  const percentMatch = raw.match(/(\d+)%/)
  if (!batteryMatch && !percentMatch) {
    return { source: sourceMatch ? sourceMatch[1] : null, present: false }
  }
  const statusRaw = batteryMatch ? normalizeKey(batteryMatch[2]) : null
  return {
    source: sourceMatch ? sourceMatch[1] : null,
    present: true,
    percent: batteryMatch ? Number(batteryMatch[1]) : Number(percentMatch[1]),
    status: statusRaw ? PMSET_STATUS[statusRaw] ?? batteryMatch[2].trim() : null,
    timeLeft: batteryMatch ? batteryMatch[3] : null,
  }
}

export function parseIoregStorageStats(text) {
  let bytesRead = 0
  let bytesWritten = 0
  for (const match of String(text ?? "").matchAll(/"Bytes \(Read\)"=(\d+)/g)) bytesRead += Number(match[1])
  for (const match of String(text ?? "").matchAll(/"Bytes \(Write\)"=(\d+)/g)) bytesWritten += Number(match[1])
  return { bytesRead, bytesWritten }
}

export function parseIoregBattery(text) {
  const raw = String(text ?? "")
  const number = (key) => {
    const match = raw.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`))
    return match ? Number(match[1]) : null
  }
  const flag = (key) => {
    const match = raw.match(new RegExp(`"${key}"\\s*=\\s*(Yes|No|true|false)`, "i"))
    if (!match) return null
    return /^(yes|true)$/i.test(match[1])
  }
  const telemetry = raw.match(/"PowerTelemetryData"\s*=\s*\{([^}]*)\}/)?.[1] ?? ""
  const telemetryNumber = (key) => {
    const match = telemetry.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`))
    return match ? Number(match[1]) : null
  }
  const adapterMatch = raw.match(/"AdapterDetails"\s*=\s*\{[^}]*?"Watts"\s*=\s*(\d+)/)
  const cycles = number("CycleCount")
  const designCapacity = number("DesignCapacity")
  const fullChargeCapacity = number("FullChargeCapacity")
  const nominalCapacity = number("NominalChargeCapacity")
  const temperature = number("Temperature")
  const amperage = number("Amperage")
  const voltage = number("Voltage")
  const systemPower = telemetryNumber("SystemPowerIn")
  const systemCurrent = telemetryNumber("SystemCurrentIn")
  const systemVoltage = telemetryNumber("SystemVoltageIn")
  const batteryPower = telemetryNumber("BatteryPower")
  const capacity = fullChargeCapacity ?? nominalCapacity
  const healthPercent =
    hasNumber(designCapacity) && designCapacity > 0 && hasNumber(capacity)
      ? Math.round((capacity / designCapacity) * 1000) / 10
      : null
  const batteryWatts =
    batteryPower != null
      ? Math.abs(batteryPower) / 1000
      : hasNumber(amperage) && hasNumber(voltage)
        ? Math.abs(amperage * voltage) / 1e6
        : null
  return {
    cycles,
    designCapacity,
    fullChargeCapacity,
    nominalCapacity,
    temperature: hasNumber(temperature) && temperature > 0 ? temperature / 10 : null,
    healthPercent,
    externalConnected: flag("ExternalConnected"),
    charging: flag("IsCharging"),
    fullyCharged: flag("FullyCharged"),
    systemWatts: systemPower != null ? Math.abs(systemPower) / 1000 : null,
    systemAmps: systemCurrent != null ? Math.abs(systemCurrent) / 1000 : null,
    systemVolts: systemVoltage != null ? Math.abs(systemVoltage) / 1000 : null,
    batteryWatts,
    batteryAmps: hasNumber(amperage) ? Math.abs(amperage) / 1000 : null,
    batteryVolts: hasNumber(voltage) ? Math.abs(voltage) / 1000 : null,
    adapterWatts: adapterMatch ? Number(adapterMatch[1]) : null,
  }
}

export function parseSystemProfilerHardware(text) {
  const json = parseJsonLoose(text)
  const item = firstArrayItem(json?.SPHardwareDataType)
  if (!item) return null
  return {
    name: item.machine_name ?? item.model_identifier ?? null,
    model: item.machine_model ?? null,
    serial: item.serial_number ?? null,
  }
}

export function parseSystemProfilerDisplays(text) {
  const json = parseJsonLoose(text)
  const item = firstArrayItem(json?.SPDisplaysDataType)
  if (!item) return null
  const refreshRaw = item.spdisplays_refresh_rate ?? item.spdisplays_ui_looks_like ?? null
  const refresh = Number(String(refreshRaw ?? "").replace(/[^\d.]/g, ""))
  return {
    gpuName: item.sppci_model ?? null,
    gpuCores: Number(item.sppci_cores) || null,
    refreshRate: Number.isFinite(refresh) && refresh > 0 ? refresh : null,
  }
}

export function parseSystemProfilerPower(text) {
  const json = parseJsonLoose(text)
  const items = Array.isArray(json?.SPPowerDataType) ? json.SPPowerDataType : []
  const battery = items.find((item) => item?.sppower_battery_health_info || item?.sppower_battery_charge_info) ?? null
  const charger = items.find((item) => numOrNull(item?.sppower_ac_charger_watts) != null) ?? null
  if (!battery && !charger) return null
  const healthInfo = battery?.sppower_battery_health_info ?? {}
  const chargeInfo = battery?.sppower_battery_charge_info ?? {}
  const capacityRaw = String(healthInfo.sppower_battery_health_maximum_capacity ?? "").replace("%", "")
  return {
    present: Boolean(battery?.sppower_battery_health_info),
    health: healthInfo.sppower_battery_health ?? null,
    healthPercent: numOrNull(capacityRaw),
    cycles: numOrNull(healthInfo.sppower_battery_cycle_count),
    stateOfCharge: numOrNull(chargeInfo.sppower_battery_state_of_charge),
    charging: chargeInfo.sppower_battery_is_charging === "TRUE" || chargeInfo.sppower_battery_is_charging === true,
    fullyCharged: chargeInfo.sppower_battery_fully_charged === "TRUE" || chargeInfo.sppower_battery_fully_charged === true,
    acWatts: charger ? numOrNull(charger.sppower_ac_charger_watts) : null,
    chargerConnected: charger ? charger.sppower_battery_charger_connected === "TRUE" : null,
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WIN_BATTERY_STATUS = {
  1: "Discharging",
  2: "AC Power",
  3: "Fully Charged",
  4: "Low",
  5: "Critical",
  6: "Charging",
  7: "Charging",
  8: "Charging (Low)",
  9: "Charging (Critical)",
  10: "Unknown",
  11: "Partially Charged",
}

export function batteryStatusLabel(code) {
  return WIN_BATTERY_STATUS[Number(code)] ?? null
}

export function parseWin32Sample(text) {
  const json = parseJsonLoose(text)
  if (!json || typeof json !== "object") return null
  const memoryRaw = json.memory ?? {}
  const diskRaw = json.disk ?? {}
  const ioRaw = json.io ?? {}
  const netRaw = json.net ?? {}
  const batteryRaw = json.battery ?? {}
  const pageRaw = json.pageFile ?? {}

  const totalKB = numOrNull(memoryRaw.totalKB)
  const freeKB = numOrNull(memoryRaw.freeKB)
  const memory = {
    total: totalKB != null ? totalKB * 1024 : null,
    free: freeKB != null ? freeKB * 1024 : null,
    available: numOrNull(memoryRaw.availableMB) != null ? numOrNull(memoryRaw.availableMB) * 1024 * 1024 : null,
    cache: numOrNull(memoryRaw.cacheBytes),
    committed: numOrNull(memoryRaw.committedBytes),
  }
  const diskTotal = numOrNull(diskRaw.total)
  const diskFree = numOrNull(diskRaw.free)
  const readBytesPerSec = numOrNull(ioRaw.readBytesPerSec)
  const writeBytesPerSec = numOrNull(ioRaw.writeBytesPerSec)
  const design = numOrNull(batteryRaw.designCapacity)
  const full = numOrNull(batteryRaw.fullChargeCapacity)
  const batteryPresent = batteryRaw.present === true || batteryRaw.present === "True"
  const healthPercent = batteryPresent && design > 0 && full > 0 ? Math.round((full / design) * 1000) / 10 : null

  return {
    time: json.time ?? null,
    memory,
    disk: {
      name: diskRaw.name ?? null,
      total: diskTotal,
      free: diskFree,
    },
    io: {
      readBytesPerSec,
      writeBytesPerSec,
      readRate: readBytesPerSec != null ? readBytesPerSec / 1e6 : null,
      writeRate: writeBytesPerSec != null ? writeBytesPerSec / 1e6 : null,
    },
    net: {
      name: netRaw.name ?? null,
      ip: netRaw.ip ?? null,
      gateway: netRaw.gateway ?? null,
      receivedBytes: numOrNull(netRaw.receivedBytes),
      sentBytes: numOrNull(netRaw.sentBytes),
      rxRate: numOrNull(netRaw.rxRate),
      txRate: numOrNull(netRaw.txRate),
      tunnel: Boolean(netRaw.tunnel),
    },
    battery: {
      present: batteryPresent,
      percent: numOrNull(batteryRaw.percent),
      status: batteryStatusLabel(batteryRaw.status) ?? null,
      statusCode: numOrNull(batteryRaw.status),
      designCapacity: design,
      fullChargeCapacity: full,
      healthPercent,
      estimatedRunTime: numOrNull(batteryRaw.estimatedRunTime),
    },
    pageFile: {
      total: numOrNull(pageRaw.totalMB) != null ? numOrNull(pageRaw.totalMB) * 1024 * 1024 : null,
      used: numOrNull(pageRaw.usedMB) != null ? numOrNull(pageRaw.usedMB) * 1024 * 1024 : null,
    },
  }
}

export function parseWin32Hardware(text) {
  const json = parseJsonLoose(text)
  if (!json || typeof json !== "object") return null
  const manufacturer = String(json.manufacturer ?? "").trim()
  const model = String(json.model ?? "").trim()
  const generic = /system manufacturer|to be filled|default string|o\.e\.m\./i
  const name = generic.test(manufacturer) ? model || manufacturer : [manufacturer, model].filter(Boolean).join(" ") || null
  const osRaw = String(json.os ?? "").replace(/^Microsoft\s+/i, "")
  const speedMhz = numOrNull(json.speed)
  return {
    name,
    chip: json.chip ?? null,
    cores: numOrNull(json.cores),
    logical: numOrNull(json.logical),
    speedGhz: speedMhz != null ? Math.round((speedMhz / 1000) * 10) / 10 : null,
    ram: numOrNull(json.ram),
    gpu: json.gpu ?? null,
    refreshRate: numOrNull(json.refresh),
    osVersion: osRaw || null,
    windowsVersion: json.version ?? null,
  }
}

export { parseJsonLoose, parseSizeToken }
