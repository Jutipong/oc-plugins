// sys-status — live collector smoke test.
//
// Runs the real platform collector for a few seconds and prints a sanitized
// summary. This is a manual debugging aid (no pass/fail harness assertions):
//
//   node test/collect-smoke.mjs
//   node test/collect-smoke.mjs --json
//
// Use it on macOS and on Windows to verify local metrics after install.

import { createCollector } from "../src/collector/index.mjs"

const asJson = process.argv.includes("--json")
const seconds = Number(process.argv.find((value) => /^\d+$/.test(value)) ?? 6)

function maskIp(value) {
  if (typeof value !== "string" || !value) return value ?? null
  const parts = value.split(".")
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`
  return value
}

function summarize(snapshot) {
  return {
    platform: snapshot.platform,
    unsupported: snapshot.unsupported,
    hardware: {
      name: snapshot.hardware?.name,
      chip: snapshot.hardware?.chip,
      gpuCores: snapshot.hardware?.gpuCores,
      totalRam: snapshot.hardware?.totalRam,
      diskSize: snapshot.hardware?.diskSize,
      osVersion: snapshot.hardware?.osVersion,
    },
    cpu: {
      usage: snapshot.cpu?.usage == null ? null : Math.round(snapshot.cpu.usage * 10) / 10,
      cores: snapshot.cpu?.perCore?.length ?? 0,
      load: snapshot.cpu?.load1 == null ? null : [snapshot.cpu.load1, snapshot.cpu.load5, snapshot.cpu.load15],
    },
    memory: {
      used: snapshot.memory?.used,
      total: snapshot.memory?.total,
      usedPercent: snapshot.memory?.usedPercent == null ? null : Math.round(snapshot.memory.usedPercent * 10) / 10,
      cached: snapshot.memory?.cached,
    },
    disk: {
      mount: snapshot.disk?.mount,
      total: snapshot.disk?.total,
      used: snapshot.disk?.used,
      usedPercent: snapshot.disk?.usedPercent == null ? null : Math.round(snapshot.disk.usedPercent * 10) / 10,
      readRate: snapshot.disk?.readRate,
      writeRate: snapshot.disk?.writeRate,
    },
    power: {
      present: snapshot.power?.present,
      percent: snapshot.power?.percent,
      status: snapshot.power?.status,
      healthPercent: snapshot.power?.healthPercent,
      cycles: snapshot.power?.cycles,
      systemWatts: snapshot.power?.systemWatts,
      systemAmps: snapshot.power?.systemAmps,
      systemVolts: snapshot.power?.systemVolts,
      batteryWatts: snapshot.power?.batteryWatts,
      batteryAmps: snapshot.power?.batteryAmps,
      batteryVolts: snapshot.power?.batteryVolts,
      adapterWatts: snapshot.power?.adapterWatts,
      acWatts: snapshot.power?.acWatts,
    },
    network: {
      name: snapshot.network?.name,
      ip: maskIp(snapshot.network?.ip),
      rxRate: snapshot.network?.rxRate,
      txRate: snapshot.network?.txRate,
      tunnel: snapshot.network?.tunnel,
    },
    health: snapshot.health,
    errors: snapshot.errors,
  }
}

const collector = createCollector({ intervalMs: 1000 })
let latest = null
let ticks = 0
const unsubscribe = collector.subscribe((snapshot) => {
  latest = snapshot
  ticks += 1
})

setTimeout(() => {
  unsubscribe()
  collector.stop()
  if (!latest) {
    console.error("No snapshot produced — collector did not tick")
    process.exit(1)
  }
  const summary = summarize(latest)
  if (asJson) console.log(JSON.stringify(summary, null, 2))
  else console.log(JSON.stringify(summary))
  const missing = []
  if (summary.cpu.usage == null) missing.push("cpu.usage")
  if (summary.memory.total == null) missing.push("memory.total")
  if (summary.disk.total == null) missing.push("disk.total")
  if (missing.length > 0) {
    console.error(`Incomplete snapshot (${ticks} ticks): ${missing.join(", ")}`)
    process.exit(1)
  }
  console.error(`OK (${ticks} ticks, platform ${summary.platform})`)
}, Math.max(2000, seconds * 1000))
