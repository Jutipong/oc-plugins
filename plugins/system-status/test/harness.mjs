// system-status — offline harness.
//
// Pure Node test runner: no OpenTUI, no Solid, no network. Real system
// commands are replaced with fixtures in the collector test. Run with
// `node test/harness.mjs` (or `bun run test`) and expect:
//
//   ALL TESTS PASSED (N assertions)

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  clampNumber,
  displayWidth,
  ema,
  formatPercent,
  formatRate,
  toNumber,
  toneForUsage,
  truncate,
} from "../src/format.mjs"
import {
  createCollector,
  parseDefaultRouteInterface,
  parseNetstatCounters,
  parseProcNetDev,
  parseProcRoute,
  parseVmStatUsed,
  pickActiveInterface,
  rateBetween,
  sampleCpu,
} from "../src/collector.mjs"
import { STATUS_FIELDS, buildPromptLine, formatNetwork } from "../src/model.mjs"
import { resolveOptions } from "../src/options.mjs"
import { createLogger, logPath } from "../src/log.mjs"
import { MOLE_PALETTE } from "../src/colors.mjs"
import { cliConfigPath, configDirectory, patchCliConfig, removeCliPlugin } from "../scripts/lib.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, "..")

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

async function testAsync(name, fn) {
  try {
    await fn()
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

function flatText(line) {
  return (line ?? []).map((segment) => segment.text).join("")
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

test("usage tones use the shared 50 / 80 buckets", () => {
  eq(toneForUsage(0), "success")
  eq(toneForUsage(49.9), "success")
  eq(toneForUsage(50), "warning")
  eq(toneForUsage(79.9), "warning")
  eq(toneForUsage(80), "danger")
  eq(toneForUsage(null), "muted")
})

test("percent formatting degrades to an em dash", () => {
  eq(formatPercent(37.4), "37%")
  eq(formatPercent(0), "0%")
  eq(formatPercent(null), "—")
  eq(formatPercent(NaN), "—")
})

test("clampNumber and ema are stable for junk input", () => {
  eq(clampNumber(undefined, 2, 1, 10), 2)
  eq(clampNumber(0, 2, 1, 10), 2)
  eq(clampNumber(0.4, 2, 1, 10), 1)
  eq(clampNumber(99, 2, 1, 10), 10)
  eq(ema(null, 40), 40)
  eq(ema(40, 60, 0.5), 50)
  eq(ema(40, null), 40)
})

test("truncate is unicode-aware and displayWidth counts cells", () => {
  eq(truncate("CPU:37%", 10), "CPU:37%")
  eq(truncate("CPU:37%", 6), "CPU:3…")
  eq(truncate("CPU:37%", 1), "…")
  eq(displayWidth("CPU:37%"), 7)
  eq(displayWidth(""), 0)
})

test("toNumber accepts numbers, bigints and numeric strings", () => {
  eq(toNumber("42"), 42)
  eq(toNumber(42n), 42)
  eq(toNumber(""), null)
  eq(toNumber("junk"), null)
  eq(toNumber(null), null)
})

test("rate formatting auto-scales bytes and stays within four cells", () => {
  eq(formatRate(null), "—")
  eq(formatRate(NaN), "—")
  eq(formatRate(-5), "—")
  eq(formatRate(0), "0B")
  eq(formatRate(512), "512B")
  eq(formatRate(1024), "1.0K")
  eq(formatRate(3.4 * 1024), "3.4K")
  eq(formatRate(12 * 1024), "12K")
  eq(formatRate(1.2 * 1024 * 1024), "1.2M")
  eq(formatRate(340 * 1024 * 1024), "340M")
  for (const value of [0, 999, 1000, 1023, 1024, 5000, 1e6, 5e8, 3e12, 1e15]) {
    ok(displayWidth(formatRate(value)) <= 4, `too wide: ${formatRate(value)}`)
  }
})

// ---------------------------------------------------------------------------
// CPU / RAM parsers
// ---------------------------------------------------------------------------

test("sampleCpu computes busy ratios from os.cpus times", () => {
  const before = [{ times: { user: 1000, nice: 0, sys: 500, idle: 10000, irq: 0 } }]
  const after = [{ times: { user: 7000, nice: 0, sys: 2500, idle: 82000, irq: 0 } }]
  const sample = sampleCpu(before, after, 1000)
  eq(Math.round(sample.usage), 10)
  eq(Math.round(sample.perCore[0]), 10)
  eq(sampleCpu([], [], 1000), { usage: null, perCore: [] })

  const tiny = sampleCpu(
    [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    [{ times: { user: 8, nice: 0, sys: 0, idle: 2, irq: 0 } }],
    1000,
  )
  ok(tiny.usage < 1, "the wall-clock floor keeps tiny deltas from reading 100%")
})

test("parseVmStatUsed sums active, wired and compressed pages", () => {
  const text = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                    100.",
    "Pages active:                                 1000.",
    "Pages inactive:                                500.",
    "Pages wired down:                              300.",
    "Pages occupied by compressor:                  200.",
  ].join("\n")
  eq(parseVmStatUsed(text), 1500 * 16384)
  eq(parseVmStatUsed(""), 0)
})

// Row shapes below are copied from a real macOS `netstat -ibn`: the first row
// of an interface carries a link address, address-less links do not.
const NETSTAT = [
  "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
  "lo0        16384 <Link#1>                       4095693     0 7747326657  4095693     0 7747326657     0",
  "lo0        16384 127           127.0.0.1        4095693     - 7747326657  4095693     - 7747326657     -",
  "gif0*      1280  <Link#2>                             0     0          0        0     0          0     0",
  "en0        1500  <Link#11>   5e:0b:7d:e6:58:1d 39241036     0 41429225438 18378917     0 17246771816     0",
  "en0        1500  192.168.1     192.168.1.115   39241036     - 41429225438 18378917     - 17246771816     -",
].join("\n")

test("parseNetstatCounters keeps one row per interface", () => {
  eq(parseNetstatCounters(NETSTAT), {
    lo0: { in: 7747326657, out: 7747326657 },
    gif0: { in: 0, out: 0 },
    en0: { in: 41429225438, out: 17246771816 },
  })
  eq(parseNetstatCounters(""), {})
  eq(parseNetstatCounters("Name Mtu Network\nen0 1500 junk"), {})
})

test("parseDefaultRouteInterface reads the interface line", () => {
  const text = ["   route to: default", "destination: default", "    gateway: 192.168.1.1", "  interface: en0"].join(
    "\n",
  )
  eq(parseDefaultRouteInterface(text), "en0")
  eq(parseDefaultRouteInterface("nope"), null)
})

test("parseProcNetDev and parseProcRoute handle the Linux pair", () => {
  const dev = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0",
    "  eth0: 123456 100 0 0 0 0 0 0 654321 90 0 0 0 0 0 0",
  ].join("\n")
  eq(parseProcNetDev(dev), { lo: { in: 1000, out: 1000 }, eth0: { in: 123456, out: 654321 } })
  eq(parseProcNetDev(""), {})

  const route = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
    "wlan0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
    "eth0\t0002A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
  ].join("\n")
  eq(parseProcRoute(route), "wlan0")
  eq(parseProcRoute("Iface\tDestination"), null)
})

test("pickActiveInterface skips loopback, bridges and dead links", () => {
  eq(
    pickActiveInterface({
      lo0: { in: 9000, out: 9000 },
      gif0: { in: 5000, out: 5000 },
      en0: { in: 50, out: 10 },
      utun3: { in: 900, out: 100 },
    }),
    "utun3",
  )
  eq(pickActiveInterface({ lo0: { in: 1, out: 1 } }), null)
  eq(pickActiveInterface({}), null)
})

test("rateBetween turns counter deltas into bytes per second", () => {
  eq(rateBetween({ in: 1000, out: 500 }, { in: 3000, out: 1500 }, 1000), { down: 2000, up: 1000 })
  eq(rateBetween({ in: 1000, out: 500 }, { in: 5000, out: 2500 }, 2000), { down: 2000, up: 1000 })
  eq(rateBetween({ in: 5000, out: 100 }, { in: 100, out: 100 }, 2000), { down: 0, up: 0 })
  eq(rateBetween(null, { in: 0, out: 0 }, 1000), null)
  eq(rateBetween({ in: 0, out: 0 }, { in: 0, out: 0 }, 0), null)
})

await testAsync("collector samples CPU/RAM/NET, publishes, and stays reference-counted", async () => {
  let step = 0
  const fakeCpus = () => {
    step += 1
    return [{ times: { user: 1000 + step * 6000, nice: 0, sys: 500 + step * 2000, idle: 10000 + step * 72000, irq: 0 } }]
  }
  let netStep = 0
  const exec = async (command) => {
    if (command.endsWith("vm_stat")) {
      return {
        ok: true,
        stdout: [
          "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
          "Pages active: 1000.",
          "Pages wired down: 300.",
          "Pages occupied by compressor: 200.",
        ].join("\n"),
      }
    }
    if (command.endsWith("netstat")) {
      netStep += 1
      const inbound = 100_000 + netStep * 200_000
      const outbound = 50_000 + netStep * 100_000
      return {
        ok: true,
        stdout: [`en0 1500 <Link#11> aa:bb:cc:dd:ee:ff 0 0 ${inbound} 0 0 ${outbound} 0`].join("\n"),
      }
    }
    if (command.endsWith("route")) return { ok: true, stdout: "  interface: en0" }
    return { ok: false, stdout: "" }
  }
  const collector = createCollector({
    intervalMs: 500,
    platform: "darwin",
    exec,
    cpus: fakeCpus,
    totalmem: () => 100 * 1024 * 1024,
    logger: { write() {} },
  })
  const seen = []
  const unsubscribe = collector.subscribe((snapshot) => seen.push(snapshot))
  // The tick interval is clamped to 500 ms, and the first NET sample only
  // establishes the counter baseline — the rate needs a second sample.
  await delay(1200)
  unsubscribe()
  collector.dispose()

  const latest = seen.at(-1)
  ok(typeof latest.cpu === "number" && latest.cpu >= 0 && latest.cpu <= 100, `cpu: ${latest.cpu}`)
  ok(typeof latest.ram === "number" && latest.ram > 0 && latest.ram <= 100, `ram: ${latest.ram}`)
  ok(latest.net && latest.net.down > 0 && latest.net.up > 0, `net: ${JSON.stringify(latest.net)}`)
  ok(!("temp" in latest), "the collector no longer publishes temperature")
  ok(seen.length > 1, "the collector publishes more than the initial snapshot")
})

await testAsync("collector leaves NET out when the network field is switched off", async () => {
  const calls = []
  const collector = createCollector({
    intervalMs: 500,
    network: false,
    platform: "darwin",
    exec: async (command) => {
      calls.push(command)
      return { ok: false, stdout: "" }
    },
    cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }],
    totalmem: () => 100 * 1024 * 1024,
    logger: { write() {} },
  })
  const seen = []
  const unsubscribe = collector.subscribe((snapshot) => seen.push(snapshot))
  await delay(700)
  unsubscribe()
  collector.dispose()

  ok(seen.length > 0, "the collector published nothing")
  ok(!("net" in seen.at(-1)), "the network field must be absent when disabled")
  ok(
    !calls.some((command) => /netstat|route/.test(command)),
    `network commands ran while disabled: ${calls.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// prompt footer model
// ---------------------------------------------------------------------------

test("prompt line renders bracketed CPU/RAM/NET with faint labels and toned values", () => {
  const line = buildPromptLine({ cpu: 37, ram: 62, net: { down: 1.2 * 1024 * 1024, up: 240 * 1024 } })
  eq(flatText(line), "[CPU:37% · RAM:62% · ↓1.2M ↑240K]")
  eq(line.map((segment) => segment.text), ["[", "CPU:", "37%", " · ", "RAM:", "62%", " · ", "↓1.2M ↑240K", "]"])
  eq(line.map((segment) => segment.tone), [
    "faint",
    "muted",
    "success",
    "faint",
    "muted",
    "warning",
    "faint",
    "success",
    "faint",
  ])

  const hot = buildPromptLine({ cpu: 91, ram: 85, net: { down: 5 * 1024 * 1024, up: 0 } })
  eq(flatText(hot), "[CPU:91% · RAM:85% · ↓5.0M ↑0B]")
  eq(hot[2].tone, "danger")
  eq(hot[5].tone, "danger")
  eq(hot[7].tone, "success")

  eq(formatNetwork({ down: 0, up: 0 }), "↓0B ↑0B")
  eq(formatNetwork({ down: 65.7, up: 161.4 }), "↓66B ↑161B")
  eq(formatNetwork(null), "↓— ↑—")
  eq(buildPromptLine({ cpu: 1, ram: 1, net: { down: 0, up: 0 } })[7].tone, "muted")
})

test("prompt line drops NET entirely when the field is switched off", () => {
  eq(flatText(buildPromptLine({ cpu: 37, ram: 62 })), "[CPU:37% · RAM:62%]")
  eq(flatText(buildPromptLine({ cpu: 37, ram: 62, net: undefined })), "[CPU:37% · RAM:62%]")
})

test("prompt line uses muted em dashes for unknown values", () => {
  const line = buildPromptLine({ cpu: null, ram: null, net: null })
  eq(flatText(line), "[CPU:— · RAM:— · ↓— ↑—]")
  eq(line[2].tone, "muted")
  eq(line[5].tone, "muted")
  eq(line[7].tone, "muted")
  eq(flatText(buildPromptLine({ cpu: null, ram: null })), "[CPU:— · RAM:—]")
})

test("prompt line marks collector failures with a warning prefix", () => {
  const line = buildPromptLine({ cpu: 37, ram: 62, stale: true })
  eq(flatText(line), "! [CPU:37% · RAM:62%]")
  eq(line[0].tone, "warning")
  eq(line[1].text, "[")
})

test("prompt line keeps brackets balanced and drops NET/RAM whole when narrow", () => {
  const view = { cpu: 37, ram: 62 }
  eq(displayWidth(flatText(buildPromptLine(view))), 19)
  eq(flatText(buildPromptLine(view, { width: 18 })), "[CPU:37%]")
  eq(flatText(buildPromptLine(view, { width: 9 })), "[CPU:37%]")
  eq(flatText(buildPromptLine(view, { width: 8 })), "[CPU:3…]")

  const full = { cpu: 37, ram: 62, net: { down: 1.2 * 1024 * 1024, up: 240 * 1024 } }
  eq(displayWidth(flatText(buildPromptLine(full))), 33)
  eq(flatText(buildPromptLine(full, { width: 33 })), "[CPU:37% · RAM:62% · ↓1.2M ↑240K]")
  eq(flatText(buildPromptLine(full, { width: 32 })), "[CPU:37% · RAM:62%]")
  eq(flatText(buildPromptLine(full, { width: 18 })), "[CPU:37%]")

  const stale = buildPromptLine({ ...view, stale: true }, { width: 8 })
  eq(flatText(stale), "! [CPU:]")
  eq(displayWidth(flatText(stale)), 8)

  for (const width of [36, 33, 32, 19, 18, 9, 8]) {
    for (const candidate of [view, full]) {
      const flat = flatText(buildPromptLine(candidate, { width }))
      ok(displayWidth(flat) <= width, `line wider than ${width}: ${flat}`)
      ok(flat.startsWith("[") || flat.startsWith("! ["), `missing opening bracket: ${flat}`)
      ok(flat.endsWith("]"), `missing closing bracket: ${flat}`)
    }
  }
  eq(STATUS_FIELDS.map((field) => field.label), ["CPU:", "RAM:", undefined])
})

test("prompt line never leaks internals", () => {
  for (const view of [
    { cpu: 0, ram: 0 },
    { cpu: null, ram: null },
    { cpu: null, ram: null, net: null },
    { cpu: 37, ram: 62, net: { down: 0, up: 0 } },
    { cpu: 37, ram: 62, net: { down: Number.NaN, up: Number.POSITIVE_INFINITY } },
    { cpu: 37, ram: 62, stale: true, error: "boom" },
    {},
  ]) {
    const text = flatText(buildPromptLine(view))
    excludes(text, "NaN")
    excludes(text, "undefined")
    excludes(text, "Infinity")
  }
})

// ---------------------------------------------------------------------------
// options, log
// ---------------------------------------------------------------------------

test("option and env resolution uses SYSTEM_STATUS_*", () => {
  eq(resolveOptions({}).intervalSeconds, 2)
  eq(resolveOptions({ options: { interval: 5 } }).intervalSeconds, 5)
  eq(resolveOptions({ env: { SYSTEM_STATUS_INTERVAL: "4" } }).intervalSeconds, 4)
  eq(resolveOptions({ options: { interval: 5 }, env: { SYSTEM_STATUS_INTERVAL: "4" } }).intervalSeconds, 5)
  eq(resolveOptions({ options: { interval: 0 } }).intervalSeconds, 2)
  eq(resolveOptions({ options: { interval: 99 } }).intervalSeconds, 10)
  eq(resolveOptions({}).colorMode, "mole")
  eq(resolveOptions({ options: { colorMode: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ env: { SYSTEM_STATUS_COLOR_MODE: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ options: { colorMode: "wat" } }).colorMode, "mole")
  eq(resolveOptions({}).network, true)
  eq(resolveOptions({ options: { network: true } }).network, true)
  eq(resolveOptions({ options: { network: false } }).network, false)
  eq(resolveOptions({ env: { SYSTEM_STATUS_NETWORK: "0" } }).network, false)
  eq(resolveOptions({ env: { SYSTEM_STATUS_NETWORK: "off" } }).network, false)
  eq(resolveOptions({ options: { network: true }, env: { SYSTEM_STATUS_NETWORK: "0" } }).network, true)
  eq(resolveOptions({ options: { network: false }, env: { SYSTEM_STATUS_NETWORK: "1" } }).network, false)
  eq(resolveOptions({}).debug, false)
  eq(resolveOptions({ options: { debug: true } }).debug, true)
  eq(resolveOptions({ env: { SYSTEM_STATUS_DEBUG: "1" } }).debug, true)
})

test("debug log is off by default and lives beside the config", () => {
  const disabled = createLogger(false, { file: path.join(HERE, "should-not-exist.log") })
  disabled.write("nope")
  eq(fs.existsSync(path.join(HERE, "should-not-exist.log")), false)
  eq(disabled.enabled, false)
  eq(logPath({}, "/home/u"), path.join("/home/u", ".config", "opencode", "plugins", "system-status-debug.log"))
  eq(
    logPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/u"),
    path.join("/tmp/xdg", "opencode", "plugins", "system-status-debug.log"),
  )
})

test("mole palette matches the other CLI plugins", () => {
  eq(MOLE_PALETTE.success, [165, 214, 167])
  eq(MOLE_PALETTE.warning, [255, 169, 77])
  eq(MOLE_PALETTE.error, [255, 95, 95])
  eq(MOLE_PALETTE.muted, [115, 115, 115])
})

// ---------------------------------------------------------------------------
// install helpers
// ---------------------------------------------------------------------------

test("config paths follow XDG/home", () => {
  eq(configDirectory({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/u"), path.join("/tmp/xdg", "opencode"))
  eq(configDirectory({}, "/home/u"), path.join("/home/u", ".config", "opencode"))
  eq(cliConfigPath({}, "/home/u"), path.join("/home/u", ".config", "opencode", "cli.json"))
})

test("patchCliConfig adds, preserves and updates entries", () => {
  const url = "file:///tmp/oc-plugins/plugins/system-status"
  const fresh = patchCliConfig('{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n', url, { options: { interval: 2 } })
  eq(fresh.config.plugins.length, 1)
  eq(fresh.config.plugins[0].package, url)
  eq(fresh.config.plugins[0].options.interval, 2)

  const existing = patchCliConfig(
    JSON.stringify({ plugins: ["opencode.example", { package: "file:///tmp/other" }] }),
    url,
    { options: { interval: 5 } },
  )
  eq(existing.config.plugins.length, 3)
  eq(existing.config.plugins[0], "opencode.example")

  const updated = patchCliConfig(existing.text, url, { options: { interval: 3 } })
  eq(updated.config.plugins.length, 3)
  eq(updated.config.plugins[2].options.interval, 3)
  eq(updated.existed, true)

  const removed = removeCliPlugin(updated.text, url)
  eq(removed.removed, true)
  eq(removed.config.plugins.length, 2)

  const untouched = removeCliPlugin(removed.text, url)
  eq(untouched.removed, false)

  const installer = fs.readFileSync(path.join(PLUGIN_DIR, "scripts/install.mjs"), "utf8")
  includes(installer, "Number(args[intervalFlag + 1]) : 2", "installer default interval must be 2 seconds")
})

// ---------------------------------------------------------------------------
// packaging and hygiene
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

test("package wiring matches the CLI plugin conventions", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"))
  eq(pkg.name, "system-status")
  eq(pkg.private, true)
  eq(pkg.exports["./tui"], "./tui.ts")
  eq(pkg.scripts.test, "node test/harness.mjs")
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.ts"), "utf8")
  includes(tui, 'export { default } from "./src/entry.tsx"')

  const entry = fs.readFileSync(path.join(PLUGIN_DIR, "src/entry.tsx"), "utf8")
  includes(entry, 'id: "system-status"')
  includes(entry, "prompt.footer.status")
  excludes(entry, "sidebar.content", "the plugin owns the prompt footer only")
  includes(entry, "createCollector")
  includes(entry, "collector.dispose()")

  const ui = fs.readFileSync(path.join(PLUGIN_DIR, "src/ui/line.tsx"), "utf8")
  includes(ui, "buildPromptLine")
  includes(ui, "subscribe")
  includes(ui, "RGBA.fromInts")

  const collector = fs.readFileSync(path.join(PLUGIN_DIR, "src/collector.mjs"), "utf8")
  includes(collector, "/usr/bin/vm_stat")
  includes(collector, "IDLE_STOP_MS")
  includes(collector, "netstat")
  includes(collector, "/proc/net/dev")
  excludes(collector, "powermetrics")
  excludes(collector, "tempCmd")
  excludes(collector, "MSAcpi")
  excludes(collector, "temperature")
})

test("the plugin stays standalone (no imports from sibling plugins)", () => {
  const crossPlugin = /from\s+["'][^"']*\.\.\/\.\.\/[a-z-]+\//
  for (const file of listFiles(PLUGIN_DIR)) {
    if (!/\.(mjs|ts|tsx)$/.test(file)) continue
    const text = fs.readFileSync(file, "utf8")
    ok(!crossPlugin.test(text), `${path.relative(PLUGIN_DIR, file)} imports another plugin`)
  }
})

test("runtime sources contain no secrets and no third-party CLI dependency", () => {
  const files = [
    path.join(PLUGIN_DIR, "tui.ts"),
    ...listFiles(path.join(PLUGIN_DIR, "src")),
    ...listFiles(path.join(PLUGIN_DIR, "scripts")),
  ].filter((file) => /\.(mjs|ts|tsx)$/.test(file))
  const secretPattern = /\bsk-[A-Za-z0-9_-]{16,}/i
  const externalTool = /\b(brew install|npx |agent-cli)\b/i
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8")
    ok(!secretPattern.test(text), `${path.relative(PLUGIN_DIR, file)} looks like it contains a secret`)
    ok(!externalTool.test(text), `${path.relative(PLUGIN_DIR, file)} references an external tool`)
  }
})

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log(`ALL TESTS PASSED (${assertions} assertions)`)
