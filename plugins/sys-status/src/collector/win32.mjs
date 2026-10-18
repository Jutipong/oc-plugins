// sys-status — Windows collector.
//
// Keeps one PowerShell process alive and streams a compact JSON line every few
// seconds (CIM/WMI queries only; no external tools). CPU/memory/uptime come
// from Node's `os` module in the shared collector, so PowerShell is only used
// for the things Node cannot see: disk/IO, network, battery and hardware.

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createDeltaTracker, run } from "./common.mjs"
import { parseWin32Hardware, parseWin32Sample } from "../parser.mjs"

const LOOP_MS = 3000
const HARDWARE_MS = 10 * 60_000
const STALE_MS = 15_000
const TUNNEL_PATTERN = /vpn|tap|tun|wireguard|tailscale|openvpn|globalprotect|zerotier|wintun/i

const LOOP_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$ipCfg = $null
$i = 0
while ($true) {
  $o = [ordered]@{ time = (Get-Date).ToString('o') }
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $o.memory = @{
      totalKB = $os.TotalVisibleMemorySize
      freeKB = $os.FreePhysicalMemory
      availableMB = $mem.AvailableMBytes
      cacheBytes = $mem.CacheBytes
      committedBytes = $mem.CommittedBytes
    }
  } catch {}
  try {
    $drive = $env:SystemDrive
    $ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"
    $o.disk = @{ name = $drive; total = $ld.Size; free = $ld.FreeSpace }
  } catch {}
  try {
    $io = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
    $o.io = @{ readBytesPerSec = $io.DiskReadBytesPerSec; writeBytesPerSec = $io.DiskWriteBytesPerSec }
  } catch {}
  try {
    if (($i % 5) -eq 0) {
      $ipCfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -First 1
    }
    if ($ipCfg) {
      $stat = Get-NetAdapterStatistics -Name $ipCfg.InterfaceAlias
      $addr = $ipCfg.IPv4Address | Select-Object -First 1
      $route = $ipCfg.IPv4DefaultGateway | Select-Object -First 1
      $o.net = @{
        name = $ipCfg.InterfaceAlias
        ip = $addr.IPAddress
        gateway = $route.NextHop
        receivedBytes = $stat.ReceivedBytes
        sentBytes = $stat.SentBytes
      }
    }
  } catch {}
  try {
    $b = Get-CimInstance Win32_Battery | Select-Object -First 1
    if ($b) {
      $o.battery = @{
        present = $true
        percent = $b.EstimatedChargeRemaining
        status = $b.BatteryStatus
        designCapacity = $b.DesignCapacity
        fullChargeCapacity = $b.FullChargeCapacity
        estimatedRunTime = $b.EstimatedRunTime
      }
    } else {
      $o.battery = @{ present = $false }
    }
  } catch {}
  try {
    if (($i % 10) -eq 0) {
      $page = Get-CimInstance Win32_PageFileUsage
      $o.pageFile = @{
        totalMB = ($page | Measure-Object -Property AllocatedBaseSize -Sum).Sum
        usedMB = ($page | Measure-Object -Property CurrentUsage -Sum).Sum
      }
    }
  } catch {}
  try {
    $o | ConvertTo-Json -Compress -Depth 4 | Write-Output
  } catch {}
  [Console]::Out.Flush()
  $i = $i + 1
  Start-Sleep -Milliseconds ${LOOP_MS}
}
`

const HARDWARE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Basic Display|Remote Display|Microsoft Basic' } | Select-Object -First 1
[pscustomobject]@{
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  ram = $cs.TotalPhysicalMemory
  chip = $cpu.Name
  cores = $cpu.NumberOfCores
  logical = $cpu.NumberOfLogicalProcessors
  speed = $cpu.MaxClockSpeed
  os = $os.Caption
  version = $os.Version
  gpu = $gpu.Name
  refresh = $gpu.CurrentRefreshRate
} | ConvertTo-Json -Compress -Depth 3
`

function findPowerShell() {
  const root = process.env.SystemRoot || process.env.windir
  const candidates = []
  if (root) candidates.push(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
  candidates.push("powershell.exe", "pwsh.exe")
  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate
    } catch {
      // ignore
    }
  }
  return candidates[0]
}

export function createWindowsSource({ logger } = {}) {
  const powershell = findPowerShell()
  const netDeltas = createDeltaTracker()

  let child = null
  let stopped = false
  let restartTimer = null
  let backoff = 2000
  let buffer = ""
  let latest = null
  let latestAt = 0
  let lastError = null
  let hardware = null
  let hardwareAt = 0
  let cacheNet = null

  function scheduleRestart(reason) {
    if (stopped || restartTimer) return
    const delay = backoff
    backoff = Math.min(30_000, Math.round(backoff * 1.6))
    logger?.warn?.(`collector stopped (${reason}); retrying in ${delay}ms`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      startLoop()
    }, delay)
  }

  function handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    const parsed = parseWin32Sample(trimmed)
    if (!parsed) {
      lastError = "invalid collector output"
      return
    }
    latest = parsed
    latestAt = Date.now()
    backoff = 2000
  }

  function startLoop() {
    if (stopped || child) return
    try {
      child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LOOP_SCRIPT], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      child = null
      lastError = String(error?.message ?? error)
      scheduleRestart("spawn failed")
      return
    }
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ""
      for (const part of parts) handleLine(part)
      if (buffer.length > 256 * 1024) buffer = ""
    })
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim()
      if (text) lastError = text.slice(-400)
    })
    child.on("error", (error) => {
      lastError = String(error?.message ?? error)
    })
    child.on("exit", (code) => {
      child = null
      if (stopped) return
      scheduleRestart(`exit ${code}`)
    })
  }

  async function refreshHardware(now) {
    if (hardware && now < hardwareAt) return
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HARDWARE_SCRIPT], {
      timeout: 10_000,
    })
    const parsed = result.ok ? parseWin32Hardware(result.stdout) : null
    if (parsed) {
      hardware = parsed
      hardwareAt = now + HARDWARE_MS
    } else {
      hardwareAt = now + 60_000
      if (result.stderr) lastError = result.stderr.trim().slice(-400)
    }
  }

  function normalize(now) {
    const sample = latest
    const hw = hardware
    const totalRam = sample?.memory?.total ?? hw?.ram ?? null
    const freeRam = sample?.memory?.free ?? null
    const usedRam = totalRam != null && freeRam != null ? Math.max(0, totalRam - freeRam) : null
    const usedPercent = totalRam ? (usedRam / totalRam) * 100 : null
    const diskTotal = sample?.disk?.total ?? null
    const diskFree = sample?.disk?.free ?? null
    const diskUsed = diskTotal != null && diskFree != null ? Math.max(0, diskTotal - diskFree) : null
    const diskPercent = diskTotal ? (diskUsed / diskTotal) * 100 : null

    const net = sample?.net ? { ...sample.net } : cacheNet
    if (net?.receivedBytes != null && net?.sentBytes != null) {
      const rx = netDeltas.update("rx", net.receivedBytes, now)
      const tx = netDeltas.update("tx", net.sentBytes, now)
      cacheNet = net
      net.rxRate = rx != null ? rx / 1e6 : null
      net.txRate = tx != null ? tx / 1e6 : null
    }

    const battery = sample?.battery ?? {}
    const hardwareName = hw
      ? {
          name: hw.name,
          chip: hw.chip,
          physical: hw.cores,
          logical: hw.logical,
          speedGhz: hw.speedGhz,
          totalRam: hw.ram ?? totalRam,
          osVersion: hw.osVersion,
          gpuName: hw.gpu,
          refreshRate: hw.refreshRate,
        }
      : {}

    const stale = latestAt > 0 && now - latestAt > STALE_MS
    const errors = []
    if (!latest) errors.push(lastError ?? "collector starting")
    else if (stale) errors.push("collector stalled")

    return {
      platform: "win32",
      hardware: {
        ...hardwareName,
        diskSize: diskTotal,
      },
      cpu: {
        physical: hw?.cores ?? null,
        logical: hw?.logical ?? null,
        speedGhz: hw?.speedGhz ?? null,
        detail: hw ? `${hw.logical ?? "?"} cores${hw.speedGhz ? ` · ${hw.speedGhz} GHz` : ""}` : null,
      },
      memory: {
        total: totalRam,
        free: freeRam,
        used: usedRam,
        usedPercent,
        available: sample?.memory?.available ?? null,
        cached: sample?.memory?.cache ?? null,
        swapTotal: sample?.pageFile?.total ?? null,
        swapUsed: sample?.pageFile?.used ?? null,
      },
      disk: {
        mount: sample?.disk?.name ?? null,
        total: diskTotal,
        used: diskUsed,
        free: diskFree,
        usedPercent: diskPercent,
        readRate: sample?.io?.readRate ?? null,
        writeRate: sample?.io?.writeRate ?? null,
      },
      network: {
        name: net?.name ?? null,
        ip: net?.ip ?? null,
        gateway: net?.gateway ?? null,
        rxRate: net?.rxRate ?? null,
        txRate: net?.txRate ?? null,
        tunnel: net?.name ? TUNNEL_PATTERN.test(net.name) : false,
      },
      power: {
        present: battery.present === true,
        percent: battery.percent ?? null,
        status: battery.status ?? null,
        healthPercent: battery.healthPercent ?? null,
        healthLabel: battery.healthPercent != null && battery.present ? (battery.healthPercent >= 80 ? "Good" : "Service") : null,
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
        timeLeft:
          Number.isFinite(battery.estimatedRunTime) && battery.estimatedRunTime > 0 && battery.estimatedRunTime < 100_000
            ? `${Math.floor(battery.estimatedRunTime / 60)}:${String(battery.estimatedRunTime % 60).padStart(2, "0")}`
            : null,
      },
      errors,
    }
  }

  return {
    start() {
      stopped = false
      if (!child) startLoop()
    },
    async sample(now) {
      if (!stopped && !child) startLoop()
      await refreshHardware(now)
      return normalize(now)
    },
    stop() {
      stopped = true
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      if (child) {
        try {
          child.kill()
        } catch {
          // ignore
        }
        child = null
      }
    },
  }
}
