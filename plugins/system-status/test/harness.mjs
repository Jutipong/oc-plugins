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
  toNumber,
  toneForUsage,
  truncate,
} from "../src/format.mjs"
import { createCollector, parseVmStatUsed, sampleCpu } from "../src/collector.mjs"
import { STATUS_FIELDS, buildPromptLine } from "../src/model.mjs"
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

await testAsync("collector samples CPU/RAM, publishes, and stays reference-counted", async () => {
  let step = 0
  const fakeCpus = () => {
    step += 1
    return [{ times: { user: 1000 + step * 6000, nice: 0, sys: 500 + step * 2000, idle: 10000 + step * 72000, irq: 0 } }]
  }
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
    return { ok: false, stdout: "" }
  }
  const collector = createCollector({
    intervalMs: 50,
    platform: "darwin",
    exec,
    cpus: fakeCpus,
    totalmem: () => 100 * 1024 * 1024,
    logger: { write() {} },
  })
  const seen = []
  const unsubscribe = collector.subscribe((snapshot) => seen.push(snapshot))
  await delay(180)
  unsubscribe()
  collector.dispose()

  const latest = seen.at(-1)
  ok(typeof latest.cpu === "number" && latest.cpu >= 0 && latest.cpu <= 100, `cpu: ${latest.cpu}`)
  ok(typeof latest.ram === "number" && latest.ram > 0 && latest.ram <= 100, `ram: ${latest.ram}`)
  ok(!("temp" in latest), "the collector no longer publishes temperature")
  ok(seen.length > 1, "the collector publishes more than the initial snapshot")
})

// ---------------------------------------------------------------------------
// prompt footer model
// ---------------------------------------------------------------------------

test("prompt line renders bracketed CPU/RAM with faint labels and toned values", () => {
  const line = buildPromptLine({ cpu: 37, ram: 62 })
  eq(flatText(line), "[CPU:37% · RAM:62%]")
  eq(line.map((segment) => segment.text), ["[", "CPU:", "37%", " · ", "RAM:", "62%", "]"])
  eq(line.map((segment) => segment.tone), ["faint", "muted", "success", "faint", "muted", "warning", "faint"])

  const hot = buildPromptLine({ cpu: 91, ram: 85 })
  eq(flatText(hot), "[CPU:91% · RAM:85%]")
  eq(hot[2].tone, "danger")
  eq(hot[5].tone, "danger")
})

test("prompt line uses muted em dashes for unknown values", () => {
  const line = buildPromptLine({ cpu: null, ram: null })
  eq(flatText(line), "[CPU:— · RAM:—]")
  eq(line[2].tone, "muted")
  eq(line[5].tone, "muted")
})

test("prompt line marks collector failures with a warning prefix", () => {
  const line = buildPromptLine({ cpu: 37, ram: 62, stale: true })
  eq(flatText(line), "! [CPU:37% · RAM:62%]")
  eq(line[0].tone, "warning")
  eq(line[1].text, "[")
})

test("prompt line keeps brackets balanced and drops RAM whole when narrow", () => {
  const view = { cpu: 37, ram: 62 }
  eq(displayWidth(flatText(buildPromptLine(view))), 19)
  eq(flatText(buildPromptLine(view, { width: 18 })), "[CPU:37%]")
  eq(flatText(buildPromptLine(view, { width: 9 })), "[CPU:37%]")
  eq(flatText(buildPromptLine(view, { width: 8 })), "[CPU:3…]")

  const stale = buildPromptLine({ ...view, stale: true }, { width: 8 })
  eq(flatText(stale), "! [CPU:]")
  eq(displayWidth(flatText(stale)), 8)

  for (const width of [36, 19, 18, 9, 8]) {
    const flat = flatText(buildPromptLine(view, { width }))
    ok(displayWidth(flat) <= width, `line wider than ${width}: ${flat}`)
    ok(flat.startsWith("["), `missing opening bracket: ${flat}`)
    ok(flat.endsWith("]"), `missing closing bracket: ${flat}`)
  }
  eq(STATUS_FIELDS.map((field) => field.label), ["CPU:", "RAM:"])
})

test("prompt line never leaks internals", () => {
  for (const view of [
    { cpu: 0, ram: 0 },
    { cpu: null, ram: null },
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
