// go-usage — offline harness.
//
// Pure Node test runner: no OpenTUI, no Solid, no network. Run with
// `node test/harness.mjs` (or `bun run test`) and expect:
//
//   ALL TESTS PASSED (N assertions)

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { displayWidth, formatCacheBadge, formatReset, formatTps, formatTpsField, toNumber, toTime, toneForCacheHit, toneForMeter, toneForTps, truncate } from "../src/format.mjs"
import { METER_KEYS, meterFromRaw, normalizeStatus } from "../src/status.mjs"
import {
  DEFAULT_BASE_URL,
  DEFAULT_FETCH_TIMEOUT_MS,
  absoluteUrl,
  buildDeviceCodeRequest,
  buildRefreshRequest,
  buildStatusRequest,
  buildTokenPollRequest,
  createAuthManager,
  fetchJson,
  needsRefresh,
  parseDeviceCode,
  parseTokenOutcome,
} from "../src/auth.mjs"
import { createUsageService } from "../src/service.mjs"
import { clampCharsPerToken, createSpeedTracker } from "../src/tps.mjs"
import { SPEED_TICK_MS, createUsageFeed } from "../src/usage-events.mjs"
import { resolveCommand } from "../src/commands.mjs"
import { DEFAULT_BRIDGE_URL, clampInterval, normalizeBridgeUrl, resolveOptions } from "../src/options.mjs"
import { createObservable } from "../src/store.mjs"
import { createLogger, logPath } from "../src/log.mjs"
import { openBrowser, openCommand } from "../src/open.mjs"
import { STATUS_METERS, buildDetailLines, buildPromptLine, cacheForSession, speedForSession } from "../src/model.mjs"
import { cacheHitPercent, createCacheTracker, readTokens } from "../src/cache.mjs"
import { MOLE_PALETTE } from "../src/colors.mjs"
import { cliConfigPath, configDirectory, patchCliConfig, removeCliPlugin } from "../scripts/lib.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, "..")
const NOW = Date.parse("2026-10-18T12:00:00.000Z")
const BASE = DEFAULT_BASE_URL

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

function jsonResponse(status, json) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (json === undefined) throw new Error("invalid json")
      return json
    },
  }
}

function createFetchMock(responses) {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`)
    if (next instanceof Error) throw next
    if (typeof next === "function") return next(url, init)
    return jsonResponse(next.status ?? 200, next.json ?? null)
  }
  return { fetchImpl, calls, remaining: () => queue.length }
}

const GO_STATUS = {
  product: "go",
  useBalance: false,
  cancelAtPeriodEnd: false,
  access: {
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-11-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: {
        startsAt: "2026-10-18T10:00:00.000Z",
        resetsAt: "2026-10-18T12:31:00.000Z",
        limitMicroCents: "1200000000",
        usedMicroCents: "1104000000",
      },
      week: {
        startsAt: "2026-10-14T00:00:00.000Z",
        resetsAt: "2026-10-19T00:12:00.000Z",
        limitMicroCents: "3000000000",
        usedMicroCents: "1350000000",
      },
      month: {
        resetsAt: "2026-10-28T02:00:00.000Z",
        limitMicroCents: "6000000000",
        usedMicroCents: "2640000000",
      },
    },
  },
}

function goStatusView(extra = {}) {
  return {
    phase: "ready",
    status: normalizeStatus(GO_STATUS, NOW),
    stale: false,
    fetchedAt: NOW,
    error: null,
    now: NOW,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

test("tone buckets are shared across the CLI plugins (50 / 80)", () => {
  eq(toneForMeter(0), "success")
  eq(toneForMeter(49.9), "success")
  eq(toneForMeter(50), "warning")
  eq(toneForMeter(79.9), "warning")
  eq(toneForMeter(80), "danger")
  eq(toneForMeter(120), "danger")
})

test("speed label keeps one decimal below 10 and rounds above it", () => {
  eq(formatTps(null), "—")
  eq(formatTps(0), "0")
  eq(formatTps(-3), "0")
  eq(formatTps(0.44), "0.4")
  eq(formatTps(7.44), "7.4")
  eq(formatTps(9.94), "9.9")
  eq(formatTps(9.96), "10")
  eq(formatTps(45.3), "45")
  eq(formatTps(120), "120")
})

test("speed buckets: >= 200 pink, >= 150 hot, >= 100 green, >= 60 amber, below that red", () => {
  eq(toneForTps(0), "danger")
  eq(toneForTps(59.9), "danger")
  eq(toneForTps(60), "warning")
  eq(toneForTps(99.9), "warning")
  eq(toneForTps(100), "success")
  eq(toneForTps(149.9), "success")
  eq(toneForTps(150), "hot")
  eq(toneForTps(199.9), "hot")
  eq(toneForTps(200), "pink")
  eq(toneForTps(900), "pink")
})

test("chars-per-token factor clamps to 1-8 with a 3.5 default", () => {
  eq(clampCharsPerToken(undefined), 3.5)
  eq(clampCharsPerToken("2.4"), 2.4)
  eq(clampCharsPerToken(0), 3.5)
  eq(clampCharsPerToken("x"), 3.5)
  eq(clampCharsPerToken(99), 8)
})

test("speed tracker converts a delta window into tokens/second", () => {
  const tracker = createSpeedTracker({ charsPerToken: 4, windowMs: 2000, freshMs: 1500, minSpanMs: 500 })
  tracker.start("s1", 0)
  tracker.push("s1", 40, 1000) // 10 tokens
  tracker.push("s1", 40, 1500) // 20 tokens over a 500 ms window
  eq(tracker.snapshot(1500), { s1: 40 })

  tracker.push("s1", 400, 2000) // 120 tokens over 1000 ms
  eq(tracker.snapshot(2000), { s1: 120 })

  // A quiet session hides after the freshness window instead of showing stale speed.
  eq(tracker.snapshot(3000), { s1: 120 })
  eq(tracker.snapshot(3501), {})

  tracker.dispose()
})

test("speed tracker isolates sessions, resets on start and forgets on end", () => {
  const tracker = createSpeedTracker({ charsPerToken: 4 })
  tracker.start("a", 0)
  tracker.start("b", 0)
  tracker.push("a", 80, 1000) // one delta: 20 tokens over the 500 ms floor
  tracker.push("b", 40, 1000)
  eq(tracker.snapshot(1000), { a: 40, b: 20 })

  tracker.start("a", 1200) // new step: old deltas no longer count
  tracker.push("a", 40, 1500)
  eq(tracker.snapshot(1500), { a: 20, b: 20 })

  tracker.end("a")
  eq(tracker.snapshot(1500), { b: 20 })

  tracker.dispose()
})

test("cache hit counts cached reads over read + fresh input", () => {
  eq(readTokens({ input: 100, cache: { read: 900, write: 50 } }), { input: 100, output: 0, read: 900, write: 50 })
  eq(readTokens({}), { input: 0, output: 0, read: 0, write: 0 })
  eq(readTokens({ input: "x", cache: { read: -5 } }), { input: 0, output: 0, read: 0, write: 0 })

  eq(cacheHitPercent({ input: 1000, cache: { read: 9000 } }), 90)
  eq(cacheHitPercent({ input: 0, cache: { read: 9000 } }), 100)
  eq(cacheHitPercent({ input: 100, cache: { read: 0 } }), 0)
  eq(cacheHitPercent({ input: 1, cache: { read: 999 } }), 99) // floor: never claim 100 by rounding
  eq(cacheHitPercent({ input: 100, cache: { read: 100, write: 800 } }), 50) // writes are not hits
  eq(cacheHitPercent({}), null)
  eq(cacheHitPercent({ cache: { read: 0, write: 400 } }), null)
})

test("cache tracker sums per-step counters per session and forgets the oldest", () => {
  const tracker = createCacheTracker({ maxSessions: 2 })
  tracker.add("a", { input: 1000, output: 10, cache: { read: 0, write: 1000 } })
  tracker.add("a", { input: 100, output: 20, cache: { read: 900, write: 0 } })
  tracker.add("b", { input: 50, cache: { read: 50 } })
  eq(tracker.snapshot(), {
    a: { percent: 45, input: 1100, read: 900, write: 1000, output: 30 },
    b: { percent: 50, input: 50, read: 50, write: 0, output: 0 },
  })

  tracker.add("a", { input: 0, cache: { read: 0 } }) // empty deltas are ignored
  eq(tracker.snapshot().a.percent, 45)

  tracker.add("c", { input: 10, cache: { read: 0 } }) // evicts the least recently used
  eq(Object.keys(tracker.snapshot()), ["b", "c"])

  tracker.clear("b")
  eq(Object.keys(tracker.snapshot()), ["c"])
  tracker.dispose()
  eq(tracker.snapshot(), {})
})

test("cache tracker ignores a re-delivered step counter", () => {
  const tracker = createCacheTracker()
  tracker.add("a", { input: 100, cache: { read: 900 } }, "msg_1")
  tracker.add("a", { input: 100, cache: { read: 900 } }, "msg_1")
  eq(tracker.snapshot().a, { percent: 90, input: 100, read: 900, write: 0, output: 0 })

  tracker.add("a", { input: 100, cache: { read: 0 } }, "msg_2")
  eq(tracker.snapshot().a.percent, 81) // 900 / 1100

  tracker.add("b", { input: 100, cache: { read: 900 } }, "msg_1") // other session, same id
  eq(tracker.snapshot().b.percent, 90)
  tracker.dispose()
})

test("cache and speed fields keep a fixed width so the row never shifts", () => {
  eq(formatCacheBadge(null), "   —")
  eq(formatCacheBadge(3), "  3%")
  eq(formatCacheBadge(87), " 87%")
  eq(formatCacheBadge(100), "100%")
  eq(formatCacheBadge(140), "100%")
  eq(formatCacheBadge("x"), "   —")
  eq(displayWidth(formatCacheBadge(3)), displayWidth(formatCacheBadge(87)))
  eq(displayWidth(formatCacheBadge(null)), displayWidth(formatCacheBadge(100)))

  eq(formatTpsField(0), "  0")
  eq(formatTpsField(7.4), "7.4")
  eq(formatTpsField(45), " 45")
  eq(formatTpsField(106), "106")
  eq(displayWidth(formatTpsField(5)), displayWidth(formatTpsField(555)))

  eq(toneForCacheHit(100), "success")
  eq(toneForCacheHit(80), "success")
  eq(toneForCacheHit(79.9), "base")
  eq(toneForCacheHit(50), "base")
  eq(toneForCacheHit(49.9), "warning")
  eq(toneForCacheHit(null), "warning")
})

test("truncate is unicode-aware and displayWidth counts cells", () => {
  eq(truncate("hello", 10), "hello")
  eq(truncate("hello", 5), "hello")
  eq(truncate("hello", 4), "hel…")
  eq(truncate("hello", 1), "…")
  eq(truncate("hello", 0), "…")
  eq(displayWidth("H:92%"), 5)
  eq(displayWidth(""), 0)
})

test("formatReset mirrors the console countdown", () => {
  const plus = (ms) => new Date(NOW + ms).toISOString()
  eq(formatReset(plus(31 * 60_000), NOW), "0h 31m")
  eq(formatReset(plus(12 * 3_600_000 + 12 * 60_000), NOW), "12h 12m")
  eq(formatReset(plus(9 * 86_400_000 + 14 * 3_600_000), NOW), "9d 14h")
  eq(formatReset(new Date(NOW - 500_000).toISOString(), NOW), "0h 0m")
  eq(formatReset((NOW + 600_000) / 1000, NOW), "0h 10m")
  eq(formatReset(null, NOW), null)
  eq(formatReset("not a date", NOW), null)
})

test("toNumber / toTime accept the wire encodings", () => {
  eq(toNumber("42"), 42)
  eq(toNumber(42n), 42)
  eq(toNumber(""), null)
  eq(toNumber("junk"), null)
  eq(toNumber(null), null)
  eq(toTime("2026-10-18T12:31:00.000Z"), Date.parse("2026-10-18T12:31:00.000Z"))
  eq(toTime((NOW + 1000) / 1000), NOW + 1000)
  eq(toTime(NOW), NOW)
  eq(toTime(0), null)
  eq(toTime("junk"), null)
})

// ---------------------------------------------------------------------------
// status normalization
// ---------------------------------------------------------------------------

test("meterFromRaw mirrors console percent/badge rules", () => {
  const rolling = meterFromRaw(GO_STATUS.access.meters.fiveHour)
  eq(rolling.percent, 92)
  eq(rolling.badge, "92%")
  eq(rolling.exhausted, false)
  eq(rolling.used, 1_104_000_000)
  eq(rolling.limit, 1_200_000_000)
  eq(rolling.resetsAt, Date.parse("2026-10-18T12:31:00.000Z"))

  const exhausted = meterFromRaw({ usedMicroCents: 1000, limitMicroCents: 1000 })
  eq(exhausted.percent, 100)
  eq(exhausted.badge, "100%")
  eq(exhausted.exhausted, true)

  const rounding = meterFromRaw({ usedMicroCents: 996, limitMicroCents: 1000 })
  eq(rounding.percent, 100)
  eq(rounding.badge, ">99%")
  eq(rounding.exhausted, false)

  const numeric = meterFromRaw({ usedMicroCents: 45, limitMicroCents: 100 })
  eq(numeric.percent, 45)
  eq(numeric.badge, "45%")

  eq(meterFromRaw({ usedMicroCents: 5, limitMicroCents: 0 }), null)
  eq(meterFromRaw({ limitMicroCents: 100 }), null)
  eq(meterFromRaw(null), null)
})

test("normalizeStatus shapes the footer data", () => {
  const status = normalizeStatus(GO_STATUS, NOW)
  eq(status.present, true)
  eq(status.plan, "Go")
  eq(status.hasAccess, true)
  eq(status.fetchedAt, NOW)
  eq(status.meters.length, 3)
  eq(status.meters.map((entry) => entry.label), ["Rolling", "Weekly", "Monthly"])
  eq(status.meters[0].meter.badge, "92%")
  eq(status.meters[1].meter.badge, "45%")
  eq(status.meters[2].meter.badge, "44%")
  eq(status.meters[2].meter.startsAt, null)

  eq(normalizeStatus({ ...GO_STATUS, product: "go-plus" }, NOW).plan, "Go Plus")
  eq(normalizeStatus({ ...GO_STATUS, product: "something" }, NOW).plan, "OpenCode Go")

  const noAccess = normalizeStatus({ ...GO_STATUS, access: null }, NOW)
  eq(noAccess.hasAccess, false)
  eq(noAccess.meters.map((entry) => entry.meter), [null, null, null])

  const none = normalizeStatus(null, NOW)
  eq(none.present, false)
  eq(none.meters, [])
  eq(none.plan, null)

  eq(METER_KEYS.length, 3)
  eq(STATUS_METERS.map((entry) => entry.prefix), ["H", "W", "M"])
})

// ---------------------------------------------------------------------------
// prompt footer model
// ---------------------------------------------------------------------------

test("prompt line renders bracketed H/W/M with faint labels and toned values", () => {
  const line = buildPromptLine(goStatusView())
  eq(flatText(line), "[H:92% · W:45% · M:44% · ⚡  0t/s]")
  eq(line.map((segment) => segment.text), [
    "[",
    "H:",
    "92%",
    " · ",
    "W:",
    "45%",
    " · ",
    "M:",
    "44%",
    " · ",
    "⚡",
    "  0",
    "t/s",
    "]",
  ])
  eq(line.map((segment) => segment.tone), [
    "faint",
    "muted",
    "danger",
    "faint",
    "muted",
    "success",
    "faint",
    "muted",
    "success",
    "faint",
    "muted",
    "muted",
    "muted",
    "faint",
  ])
})

test("prompt line uses muted placeholders for missing meters", () => {
  const status = normalizeStatus({ product: "go", access: { meters: { fiveHour: null, week: null, month: null } } }, NOW)
  const line = buildPromptLine({ phase: "ready", status })
  eq(flatText(line), "[H:— · W:— · M:— · ⚡  0t/s]")
  eq(line[1].tone, "muted")
  eq(line[2].tone, "muted")
  eq(line[4].tone, "muted")
  eq(line[5].tone, "muted")

  const partial = normalizeStatus({ product: "go", access: { meters: { fiveHour: { usedMicroCents: 1, limitMicroCents: 2 } } } }, NOW)
  eq(flatText(buildPromptLine({ phase: "ready", status: partial })), "[H:50% · W:— · M:— · ⚡  0t/s]")
})

test("prompt line marks stale values with a warning prefix", () => {
  const line = buildPromptLine(goStatusView({ stale: true, error: "HTTP 500" }))
  eq(flatText(line), "! [H:92% · W:45% · M:44% · ⚡  0t/s]")
  eq(line[0].tone, "warning")
  eq(line[1].text, "[")
  eq(line[3].tone, "danger")
})

test("prompt line appends the live speed field with tier tones", () => {
  const line = buildPromptLine(goStatusView({ speed: 120.3 }))
  eq(flatText(line), "[H:92% · W:45% · M:44% · ⚡120t/s]")
  eq(line.map((segment) => segment.text), [
    "[",
    "H:",
    "92%",
    " · ",
    "W:",
    "45%",
    " · ",
    "M:",
    "44%",
    " · ",
    "⚡",
    "120",
    "t/s",
    "]",
  ])
  eq(line[10].tone, "muted")
  eq(line[11].tone, "success")
  eq(line[12].tone, "muted")

  eq(flatText(buildPromptLine(goStatusView({ speed: 70.4 }))), "[H:92% · W:45% · M:44% · ⚡ 70t/s]")
  eq(buildPromptLine(goStatusView({ speed: 70.4 }))[11].tone, "warning")
  eq(flatText(buildPromptLine(goStatusView({ speed: 180.4 }))), "[H:92% · W:45% · M:44% · ⚡180t/s]")
  eq(buildPromptLine(goStatusView({ speed: 180.4 }))[11].tone, "hot")
  eq(flatText(buildPromptLine(goStatusView({ speed: 250.4 }))), "[H:92% · W:45% · M:44% · ⚡250t/s]")
  eq(buildPromptLine(goStatusView({ speed: 250.4 }))[11].tone, "pink")
  eq(flatText(buildPromptLine(goStatusView({ speed: 4.26 }))), "[H:92% · W:45% · M:44% · ⚡4.3t/s]")
  eq(buildPromptLine(goStatusView({ speed: 4.26 }))[11].tone, "danger")

  const idle = buildPromptLine(goStatusView({ speed: null }))
  eq(flatText(idle), "[H:92% · W:45% · M:44% · ⚡  0t/s]")
  eq(idle[11].text, "  0")
  eq(idle[11].tone, "muted")
  eq(flatText(buildPromptLine(goStatusView({ speed: 0 }))), "[H:92% · W:45% · M:44% · ⚡  0t/s]")
  eq(buildPromptLine(goStatusView({ speed: 0 }))[11].tone, "muted")
})

test("speed only renders on the ready row and drops first when narrow", () => {
  eq(flatText(buildPromptLine({ phase: "error", error: "HTTP 500", speed: 45 })), "Go !")
  eq(flatText(buildPromptLine({ phase: "checking", speed: 45 })), "Go …")

  const view = goStatusView({ speed: 45.3 })
  eq(flatText(buildPromptLine(view, { width: 33 })), "[H:92% · W:45% · M:44% · ⚡ 45t/s]")
  eq(flatText(buildPromptLine(view, { width: 32 })), "[H:92% · W:45% · M:44%]")
  eq(flatText(buildPromptLine(view, { width: 22 })), "[H:92% · W:45%]")

  const idle = goStatusView({ speed: null })
  eq(flatText(buildPromptLine(idle, { width: 33 })), "[H:92% · W:45% · M:44% · ⚡  0t/s]")
  eq(flatText(buildPromptLine(idle, { width: 32 })), "[H:92% · W:45% · M:44%]")
})

test("speedForSession only returns the footer session's own live rate", () => {
  const speeds = { ses_a: 45, ses_b: 8.4 }
  eq(speedForSession(speeds, "ses_a"), 45)
  eq(speedForSession(speeds, "ses_b"), 8.4)
  eq(speedForSession(speeds, "ses_c"), null)
  eq(speedForSession(speeds, undefined), null)
  eq(speedForSession(undefined, "ses_a"), null)
  eq(speedForSession({ ses_a: 0 }, "ses_a"), null)
  eq(speedForSession({ ses_a: "x" }, "ses_a"), null)
})

test("cacheForSession only returns the footer session's own counters", () => {
  const caches = { ses_a: { percent: 87 }, ses_b: { percent: 12 } }
  eq(cacheForSession(caches, "ses_a"), { percent: 87 })
  eq(cacheForSession(caches, "ses_c"), null)
  eq(cacheForSession(caches, undefined), null)
  eq(cacheForSession(undefined, "ses_a"), null)
  eq(cacheForSession({ ses_a: 87 }, "ses_a"), null)
})

test("prompt line adds the cache field after a pipe and keeps the speed field", () => {
  const line = buildPromptLine(goStatusView({ speed: 106, cache: { percent: 87 } }))
  eq(flatText(line), "[H:92% · W:45% · M:44% | C: 87% · ⚡106t/s]")
  eq(line.map((segment) => segment.text), [
    "[",
    "H:",
    "92%",
    " · ",
    "W:",
    "45%",
    " · ",
    "M:",
    "44%",
    " | ",
    "C:",
    " 87%",
    " · ",
    "⚡",
    "106",
    "t/s",
    "]",
  ])
  eq(line[9].tone, "faint")
  eq(line[10].tone, "muted")
  eq(line[11].tone, "success")

  eq(flatText(buildPromptLine(goStatusView({ cache: { percent: 50 } }))), "[H:92% · W:45% · M:44% | C: 50% · ⚡  0t/s]")
  eq(buildPromptLine(goStatusView({ cache: { percent: 50 } }))[11].tone, "base")
  eq(buildPromptLine(goStatusView({ cache: { percent: 12 } }))[11].tone, "warning")

  const empty = buildPromptLine(goStatusView({ cache: null }))
  eq(flatText(empty), "[H:92% · W:45% · M:44% | C:   — · ⚡  0t/s]")
  eq(empty[11].tone, "muted")
})

test("cache field never shifts the row when values change width", () => {
  const widths = [3, 45, 100, null].map(
    (percent) => displayWidth(flatText(buildPromptLine(goStatusView({ speed: 5, cache: { percent } })))),
  )
  eq(new Set(widths).size, 1)

  const speeds = [5, 45, 555].map(
    (speed) => displayWidth(flatText(buildPromptLine(goStatusView({ speed, cache: { percent: 87 } })))),
  )
  eq(new Set(speeds).size, 1)
})

test("cache field widens the default row and drops after the speed field", () => {
  const full = goStatusView({ speed: 106, cache: { percent: 87 } })
  eq(displayWidth(flatText(buildPromptLine(full))), 42)
  // Widest case: every meter at 100%.
  const maxed = normalizeStatus(
    {
      product: "go",
      access: {
        meters: {
          fiveHour: { usedMicroCents: "2000000000", limitMicroCents: "2000000000" },
          week: { usedMicroCents: "2000000000", limitMicroCents: "2000000000" },
          month: { usedMicroCents: "2000000000", limitMicroCents: "2000000000" },
        },
      },
    },
    NOW,
  )
  eq(displayWidth(flatText(buildPromptLine({ phase: "ready", status: maxed, speed: 999, cache: { percent: 100 } }))), 45)

  eq(flatText(buildPromptLine(full, { width: 41 })), "[H:92% · W:45% · M:44% | C: 87%]")
  eq(flatText(buildPromptLine(full, { width: 32 })), "[H:92% · W:45% · M:44% | C: 87%]")
  eq(flatText(buildPromptLine(full, { width: 31 })), "[H:92% · W:45% · M:44%]")
  eq(flatText(buildPromptLine(full, { width: 22 })), "[H:92% · W:45%]")
  eq(flatText(buildPromptLine(full, { width: 8 })), "[H:92%]")

  // Cache disabled: the line is back to the compact layout and 40 cells.
  eq(displayWidth(flatText(buildPromptLine(goStatusView({ speed: 106 })))), 33)
})

test("prompt line drops trailing meters whole and keeps the brackets balanced", () => {
  const view = goStatusView()
  eq(flatText(buildPromptLine(view, { width: 23 })), "[H:92% · W:45% · M:44%]")
  eq(flatText(buildPromptLine(view, { width: 22 })), "[H:92% · W:45%]")
  eq(flatText(buildPromptLine(view, { width: 16 })), "[H:92% · W:45%]")
  eq(flatText(buildPromptLine(view, { width: 15 })), "[H:92% · W:45%]")
  eq(flatText(buildPromptLine(view, { width: 14 })), "[H:92%]")
  eq(flatText(buildPromptLine(view, { width: 8 })), "[H:92%]")

  const stale = buildPromptLine(goStatusView({ stale: true }), { width: 8 })
  eq(flatText(stale), "! [H:9…]")
  eq(displayWidth(flatText(stale)), 8)
})

test("prompt line shows a state marker for every non-ready phase", () => {
  eq(flatText(buildPromptLine({ phase: "checking" })), "Go …")
  eq(flatText(buildPromptLine({ phase: "loading" })), "Go …")
  eq(flatText(buildPromptLine({ phase: "disconnected" })), "Go —")
  eq(buildPromptLine({ phase: "disconnected" })[0].tone, "warning")
  eq(flatText(buildPromptLine({ phase: "absent" })), "Go —")
  eq(flatText(buildPromptLine({ phase: "error", error: "HTTP 500" })), "Go !")
  eq(buildPromptLine({ phase: "error" })[0].tone, "danger")
  eq(flatText(buildPromptLine({})), "Go …")
  eq(flatText(buildPromptLine({ phase: "wat" })), "Go …")
})

test("prompt line never exceeds the requested width and never leaks internals", () => {
  const views = [
    goStatusView(),
    goStatusView({ speed: 45.3 }),
    goStatusView({ speed: 4.2, stale: true }),
    goStatusView({ speed: 106, cache: { percent: 87 } }),
    goStatusView({ speed: 106, cache: null, stale: true }),
    goStatusView({ cache: { percent: 3 } }),
    goStatusView({ stale: true, error: "HTTP 500" }),
    { phase: "checking" },
    { phase: "loading" },
    { phase: "disconnected" },
    { phase: "absent" },
    { phase: "error", error: "a very long network failure message that should be clipped" },
  ]
  for (const view of views) {
    const text = flatText(buildPromptLine(view))
    excludes(text, "NaN")
    excludes(text, "undefined")
    excludes(text, "Infinity")
    for (const width of [36, 24, 16, 8]) {
      const line = buildPromptLine(view, { width })
      const flat = flatText(line)
      ok(displayWidth(flat) <= width, `line wider than ${width}: ${flat}`)
      if (view.phase === "ready") {
        ok(flat.startsWith("[") || flat.startsWith("! ["), `missing opening bracket: ${flat}`)
        ok(flat.endsWith("]"), `missing closing bracket: ${flat}`)
        eq((flat.match(/\[/g) ?? []).length, 1)
        eq((flat.match(/\]/g) ?? []).length, 1)
      }
    }
  }
})

test("detail dialog text covers every phase", () => {
  includes(buildDetailLines(goStatusView()).join("\n"), "Plan: Go")
  includes(buildDetailLines(goStatusView()).join("\n"), "Rolling: 92% · resets in 0h 31m")
  includes(buildDetailLines(goStatusView()).join("\n"), "Weekly: 45% · resets in 12h 12m")
  includes(buildDetailLines(goStatusView({ stale: true })).join("\n"), "latest refresh failed")
  includes(buildDetailLines({ phase: "checking" }).join("\n"), "/go-usage and approve")
  includes(buildDetailLines({ phase: "loading" }).join("\n"), "Checking your OpenCode Go usage")
  includes(buildDetailLines({ phase: "disconnected" }).join("\n"), "/go-usage again to reconnect")
  includes(buildDetailLines({ phase: "absent" }).join("\n"), "https://opencode.ai/console")
  includes(buildDetailLines({ phase: "error", error: "HTTP 500" }).join("\n"), "HTTP 500")
  includes(buildDetailLines({ phase: "ready" }).join("\n"), "No usage data yet.")
})

test("no-argument /go-usage is a smart command", () => {
  eq(resolveCommand("", "checking"), "login")
  eq(resolveCommand("", "disconnected"), "login")
  eq(resolveCommand("", "ready"), "details")
  eq(resolveCommand("", "absent"), "details")
  eq(resolveCommand("", "loading"), "details")
  eq(resolveCommand(undefined, "checking"), "login")
  eq(resolveCommand("  ", "ready"), "details")
  eq(resolveCommand("login", "ready"), "login")
  eq(resolveCommand("connect", "ready"), "login")
  eq(resolveCommand("logout", "ready"), "logout")
  eq(resolveCommand("disconnect", "ready"), "logout")
  eq(resolveCommand("  LOGOUT  ", "ready"), "logout")
  eq(resolveCommand("Refresh", "ready"), "refresh")
  eq(resolveCommand("wat", "ready"), "unknown")
})

// ---------------------------------------------------------------------------
// auth (pure)
// ---------------------------------------------------------------------------

test("device flow requests match the CLI console integration", () => {
  const code = buildDeviceCodeRequest(BASE)
  eq(code.url, `${BASE}/auth/device/code`)
  eq(JSON.parse(code.init.body), { client_id: "opencode-cli", supports_org_scope: true })
  eq(code.init.method, "POST")

  const poll = buildTokenPollRequest(BASE, "dev-123")
  eq(poll.url, `${BASE}/auth/device/token`)
  eq(JSON.parse(poll.init.body), {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "dev-123",
    client_id: "opencode-cli",
  })

  const refresh = buildRefreshRequest(`${BASE}/`, "refresh-1")
  eq(refresh.url, `${BASE}/auth/device/token`)
  eq(JSON.parse(refresh.init.body), {
    grant_type: "refresh_token",
    refresh_token: "refresh-1",
    client_id: "opencode-cli",
  })
})

test("status request carries the bearer token and optional org scope", () => {
  const request = buildStatusRequest(BASE, "access-1", "wrk_123")
  eq(request.url, `${BASE}/api/go/status`)
  eq(request.init.method, "GET")
  eq(request.init.headers.authorization, "Bearer access-1")
  eq(request.init.headers["x-org-id"], "wrk_123")

  const plain = buildStatusRequest(BASE, "access-1", null)
  eq(plain.init.headers["x-org-id"], undefined)
})

test("parseDeviceCode resolves the console verification URL", () => {
  const flow = parseDeviceCode(
    {
      device_code: "dev-1",
      user_code: "QCFW-ZTGL",
      verification_uri_complete: "/console/device?user_code=QCFW-ZTGL&client_id=opencode-cli",
      expires_in: 600,
      interval: 1,
    },
    BASE,
  )
  eq(flow.deviceCode, "dev-1")
  eq(flow.userCode, "QCFW-ZTGL")
  eq(flow.url, "https://opencode.ai/console/device?user_code=QCFW-ZTGL&client_id=opencode-cli")
  eq(flow.expiresInMs, 600_000)
  eq(flow.intervalMs, 1_000)

  eq(parseDeviceCode({ user_code: "X" }, BASE), null)
  eq(parseDeviceCode(null, BASE), null)
  eq(absoluteUrl("https://example.com/x", BASE), "https://example.com/x")
  eq(absoluteUrl("", BASE), null)
})

test("parseTokenOutcome classifies every device-flow answer", () => {
  eq(parseTokenOutcome(200, { access_token: "a", refresh_token: "r", expires_in: 3600, org_id: "wrk_1" }, NOW), {
    kind: "ok",
    tokens: { access: "a", refresh: "r", orgId: "wrk_1", expiresAt: NOW + 3_600_000 },
  })
  eq(parseTokenOutcome(200, { access_token: "a" }, NOW).tokens.expiresAt, NOW + 3_600_000)
  eq(parseTokenOutcome(400, { error: "authorization_pending" }).kind, "pending")
  eq(parseTokenOutcome(400, { error: "slow_down" }).kind, "slow-down")
  eq(parseTokenOutcome(400, { error: "expired_token" }).kind, "expired")
  eq(parseTokenOutcome(400, { error: "access_denied" }).kind, "denied")
  eq(parseTokenOutcome(400, { error: "invalid_grant" }).kind, "invalid")
  eq(parseTokenOutcome(500, null), { kind: "error", status: 500, error: null })
})

test("needsRefresh respects the expiry skew", () => {
  eq(needsRefresh(null), false)
  eq(needsRefresh({ access: "a", refresh: "r", expiresAt: NOW + 30_000 }, NOW), true)
  eq(needsRefresh({ access: "a", refresh: "r", expiresAt: NOW + 120_000 }, NOW), false)
  eq(needsRefresh({ access: "a" }, NOW), false)
  eq(needsRefresh({ refresh: "r", expiresAt: 0 }, NOW), true)
})

await testAsync("auth manager walks the device flow with slow_down backoff", async () => {
  const mock = createFetchMock([
    {
      status: 200,
      json: { device_code: "dev", user_code: "CODE", verification_uri_complete: "/console/device?user_code=CODE", expires_in: 600, interval: 1 },
    },
    { status: 400, json: { error: "authorization_pending" } },
    { status: 400, json: { error: "slow_down" } },
    { status: 200, json: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, org_id: "wrk_9" } },
  ])
  const delays = []
  let fakeNow = 0
  const persisted = []
  const auth = createAuthManager({
    fetchImpl: mock.fetchImpl,
    baseUrl: BASE,
    now: () => fakeNow,
    delay: async (ms) => {
      delays.push(ms)
      fakeNow += ms
    },
    persist: (next) => persisted.push(next),
  })

  const started = await auth.beginLogin()
  eq(started.kind, "ok")
  const result = await auth.completeLogin(started.flow)
  eq(result.kind, "ok")
  eq(delays, [1_000, 1_000, 6_000])
  eq(auth.connected, true)
  eq(auth.auth.access, "access-1")
  eq(auth.auth.orgId, "wrk_9")
  eq(persisted.length, 1)
  eq(mock.calls[1].url, `${BASE}/auth/device/token`)
})

await testAsync("auth manager cancels, expires and refreshes", async () => {
  const cancelMock = createFetchMock([
    { status: 200, json: { device_code: "d", user_code: "C", verification_uri_complete: "/console/device?x=1", expires_in: 600, interval: 1 } },
    { status: 400, json: { error: "authorization_pending" } },
  ])
  let fakeNow = 0
  const cancelling = createAuthManager({
    fetchImpl: cancelMock.fetchImpl,
    baseUrl: BASE,
    now: () => fakeNow,
    delay: async (ms) => {
      fakeNow += ms
    },
  })
  const started = await cancelling.beginLogin()
  let polls = 0
  const cancelled = await cancelling.completeLogin(started.flow, { shouldCancel: () => ++polls > 1 })
  eq(cancelled.kind, "cancelled")
  eq(cancelMock.calls.length, 2)

  const pendingResponse = { status: 400, json: { error: "authorization_pending" } }
  const expiredMock = createFetchMock([
    { status: 200, json: { device_code: "d", user_code: "C", verification_uri_complete: "/console/device?x=1", expires_in: 30, interval: 1 } },
    ...Array.from({ length: 40 }, () => pendingResponse),
  ])
  let expiredNow = 0
  const expiring = createAuthManager({
    fetchImpl: expiredMock.fetchImpl,
    baseUrl: BASE,
    now: () => expiredNow,
    delay: async (ms) => {
      expiredNow += ms
    },
  })
  const expiredFlow = await expiring.beginLogin()
  const expired = await expiring.completeLogin(expiredFlow.flow)
  eq(expired.kind, "expired")

  const refreshMock = createFetchMock([
    { status: 200, json: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 } },
    { status: 400, json: { error: "invalid_grant" } },
  ])
  const auth = createAuthManager({
    fetchImpl: refreshMock.fetchImpl,
    baseUrl: BASE,
    initial: { access: "access-1", refresh: "refresh-1", expiresAt: NOW, orgId: "wrk_1" },
    now: () => NOW,
  })
  const refreshed = await auth.refresh()
  eq(refreshed.access, "access-2")
  eq(refreshed.orgId, "wrk_1", "org scope survives refresh")
  const token = await auth.accessToken()
  eq(token, "access-2")
  eq(refreshMock.remaining(), 1)

  const failing = createAuthManager({
    fetchImpl: refreshMock.fetchImpl,
    baseUrl: BASE,
    initial: { access: "a", refresh: "r", expiresAt: NOW + 10_000 },
    now: () => NOW,
  })
  eq(await failing.refresh(), null)
  const kept = createAuthManager({
    fetchImpl: createFetchMock([]).fetchImpl,
    baseUrl: BASE,
    initial: null,
  })
  eq(kept.adopt({ access: "late", refresh: "r", expiresAt: NOW + 10_000_000 }).access, "late")
  kept.logout()
  eq(kept.connected, false)
})

// ---------------------------------------------------------------------------
// usage service
// ---------------------------------------------------------------------------

function connectedAuth({ access = "access-1", refresh = "refresh-1", orgId = "wrk_1", expiresAt = NOW + 3_600_000 } = {}) {
  let current = { access, refresh, orgId, expiresAt }
  return {
    get auth() {
      return current
    },
    get connected() {
      return Boolean(current)
    },
    async accessToken() {
      return current?.access ?? null
    },
    async refresh() {
      current = { access: "access-2", refresh: "refresh-2", orgId: current.orgId, expiresAt: NOW + 3_600_000 }
      return current
    },
    logout() {
      current = null
    },
  }
}

await testAsync("service fetches usage over the console API", async () => {
  const mock = createFetchMock([{ status: 200, json: GO_STATUS }])
  const service = createUsageService({ fetchImpl: mock.fetchImpl, baseUrl: BASE, auth: connectedAuth(), userAgent: "test/1" })
  const outcome = await service.fetchStatus()
  eq(outcome.kind, "ok")
  eq(mock.calls[0].url, `${BASE}/api/go/status`)
  eq(mock.calls[0].init.headers.authorization, "Bearer access-1")
  eq(mock.calls[0].init.headers["x-org-id"], "wrk_1")
  eq(mock.calls[0].init.headers["user-agent"], "test/1")
})

await testAsync("service refreshes once on 401 and retries", async () => {
  const mock = createFetchMock([{ status: 401, json: { _tag: "Unauthorized" } }, { status: 200, json: GO_STATUS }])
  const service = createUsageService({ fetchImpl: mock.fetchImpl, baseUrl: BASE, auth: connectedAuth() })
  const outcome = await service.fetchStatus()
  eq(outcome.kind, "ok")
  eq(mock.calls.length, 2)
  eq(mock.calls[1].init.headers.authorization, "Bearer access-2")
  eq(mock.remaining(), 0)
})

await testAsync("service surfaces unauthorized, absent, http and network errors", async () => {
  const none = createUsageService({ fetchImpl: createFetchMock([]).fetchImpl, baseUrl: BASE, auth: null })
  eq((await none.fetchStatus()).kind, "disconnected")

  const failingRefreshMock = createFetchMock([{ status: 401, json: {} }, { status: 400, json: { error: "invalid_grant" } }])
  const deniedAuth = connectedAuth()
  deniedAuth.refresh = async () => null
  const denied = createUsageService({ fetchImpl: failingRefreshMock.fetchImpl, baseUrl: BASE, auth: deniedAuth })
  eq((await denied.fetchStatus()).kind, "unauthorized")

  const absent = createUsageService({ fetchImpl: createFetchMock([{ status: 200, json: null }]).fetchImpl, baseUrl: BASE, auth: connectedAuth() })
  eq((await absent.fetchStatus()).kind, "absent")

  const http = createUsageService({ fetchImpl: createFetchMock([{ status: 500, json: null }]).fetchImpl, baseUrl: BASE, auth: connectedAuth() })
  const error = await http.fetchStatus()
  eq(error.kind, "error")
  eq(error.status, 500)

  const thrown = createUsageService({ fetchImpl: async () => { throw new Error("socket closed") }, baseUrl: BASE, auth: connectedAuth() })
  const network = await thrown.fetchStatus()
  eq(network.kind, "error")
  eq(network.message, "socket closed")

  const scopedMock = createFetchMock([{ status: 200, json: GO_STATUS }])
  const scoped = createUsageService({ fetchImpl: scopedMock.fetchImpl, baseUrl: BASE, auth: connectedAuth(), orgId: "wrk_env" })
  await scoped.fetchStatus()
  eq(scopedMock.calls[0].init.headers["x-org-id"], "wrk_env")
})

// ---------------------------------------------------------------------------
// usage events (runtime feed)
// ---------------------------------------------------------------------------

function usageEvent(type, data = {}, directory = "/work") {
  return { details: { type, data, location: { directory } } }
}

test("usage feed turns deltas into a speed snapshot", () => {
  const speeds = []
  const feed = createUsageFeed({ directory: "/work", charsPerToken: 3.5, onSpeed: (next) => speeds.push(next) })
  feed.onEvent(usageEvent("session.step.started", { sessionID: "ses_a" }))
  feed.onEvent(usageEvent("session.text.delta", { sessionID: "ses_a", delta: "hello world!!!" }))
  feed.tick()
  eq(speeds.length, 1)
  eq(speeds[0].ses_a, 8) // 14 chars / 3.5 per token over the 500 ms floor
  feed.tick()
  eq(speeds.length, 1) // an unchanged snapshot is not republished
  feed.onEvent(usageEvent("session.execution.succeeded", { sessionID: "ses_a" }))
  eq(speeds.length, 2)
  eq(speeds[1], {})
  feed.dispose()
})

test("usage feed ignores other directories and unrelated events", () => {
  const speeds = []
  const caches = []
  const feed = createUsageFeed({ directory: "/work", onSpeed: (next) => speeds.push(next), onCache: (next) => caches.push(next) })
  feed.onEvent(usageEvent("session.text.delta", { sessionID: "ses_a", delta: "zzzz" }, "/elsewhere"))
  feed.onEvent(usageEvent("session.step.ended", { sessionID: "ses_a", tokens: { input: 1, cache: { read: 1 } } }, "/elsewhere"))
  feed.tick()
  eq(speeds, [])
  eq(caches, [])

  feed.onEvent(null)
  feed.onEvent({})
  feed.onEvent({ details: { type: "session.text.delta" } })
  feed.onEvent(usageEvent("session.updated", { sessionID: "ses_a" }))
  feed.onEvent(usageEvent("session.text.delta", { delta: "no session id" }))
  eq(speeds, [])
  eq(caches, [])
  feed.dispose()
})

test("usage feed accumulates cache counters and skips replayed steps", () => {
  const caches = []
  const feed = createUsageFeed({ tps: false, directory: "/work", onCache: (next) => caches.push(next) })
  const tokens = { input: 100, cache: { read: 900 } }
  feed.onEvent(usageEvent("session.step.ended", { sessionID: "ses_a", tokens, assistantMessageID: "msg_1" }))
  eq(caches.length, 1)
  eq(caches[0].ses_a.percent, 90)

  feed.onEvent(usageEvent("session.step.ended", { sessionID: "ses_a", tokens, assistantMessageID: "msg_1" }))
  eq(caches.length, 1) // replayed durable event + identical snapshot

  feed.onEvent(usageEvent("session.step.ended", { sessionID: "ses_a", tokens: { input: 100, cache: { read: 0 } }, assistantMessageID: "msg_2" }))
  eq(caches.length, 2)
  eq(caches[1].ses_a.percent, 81) // 900 / 1100
  feed.dispose()
})

test("usage feed honours the tps and cache switches", () => {
  let speed = 0
  let cache = 0
  const feed = createUsageFeed({ tps: false, cache: false, onSpeed: () => (speed += 1), onCache: () => (cache += 1) })
  feed.onEvent(usageEvent("session.text.delta", { sessionID: "ses_a", delta: "xxxx" }))
  feed.onEvent(usageEvent("session.step.ended", { sessionID: "ses_a", tokens: { input: 5, cache: { read: 5 } } }))
  feed.tick()
  eq(speed, 0)
  eq(cache, 0)
  eq(SPEED_TICK_MS, 500)
  feed.dispose()
})

test("usage feed logs instead of throwing when a publisher fails", () => {
  const lines = []
  const feed = createUsageFeed({
    directory: "/work",
    log: { write: (line) => lines.push(line) },
    onSpeed: () => {
      throw new Error("boom")
    },
  })
  feed.onEvent(usageEvent("session.text.delta", { sessionID: "ses_a", delta: "xxxx" }))
  feed.tick()
  eq(lines.length, 1)
  includes(lines[0], "boom")
  feed.dispose()
})

await testAsync("fetchJson aborts a request that outlives its timeout", async () => {
  const calls = []
  const hung = (url, init) => {
    calls.push(init)
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")))
    })
  }
  let error = null
  try {
    await fetchJson(hung, { url: `${BASE}/api/go/status`, init: { method: "GET", headers: {} } }, "test/1", { timeoutMs: 20 })
  } catch (caught) {
    error = caught
  }
  includes(String(error?.message), "aborted")
  ok(calls[0].signal instanceof AbortSignal)
  eq(calls[0].headers["user-agent"], "test/1")
  eq(DEFAULT_FETCH_TIMEOUT_MS, 15_000)
})

// ---------------------------------------------------------------------------
// options, store, log, open
// ---------------------------------------------------------------------------

test("option and env resolution uses GO_USAGE_*", () => {
  eq(clampInterval(undefined), 300)
  eq(clampInterval(5), 15)
  eq(clampInterval(120), 120)
  eq(clampInterval(100_000), 3600)
  eq(resolveOptions({}).intervalSeconds, 300)
  eq(resolveOptions({ options: { interval: 90 } }).intervalSeconds, 90)
  eq(resolveOptions({ env: { GO_USAGE_INTERVAL: "30" } }).intervalSeconds, 30)
  eq(resolveOptions({ options: { interval: 90 }, env: { GO_USAGE_INTERVAL: "30" } }).intervalSeconds, 90)
  eq(resolveOptions({ env: { GO_USAGE_BASE_URL: "https://example.com/console/" } }).baseUrl, "https://example.com/console")
  eq(resolveOptions({}).baseUrl, DEFAULT_BASE_URL)
  eq(resolveOptions({ options: { openBrowser: false } }).openBrowser, false)
  eq(resolveOptions({ env: { GO_USAGE_NO_OPEN: "1" } }).openBrowser, false)
  eq(resolveOptions({ options: { debug: true } }).debug, true)
  eq(resolveOptions({ env: { GO_USAGE_DEBUG: "1" } }).debug, true)
  eq(resolveOptions({ env: { GO_USAGE_ORG: "wrk_env" } }).orgId, "wrk_env")
  eq(resolveOptions({}).colorMode, "mole")
  eq(resolveOptions({ options: { colorMode: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ env: { GO_USAGE_COLOR_MODE: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ options: { colorMode: "wat" } }).colorMode, "mole")
  eq(resolveOptions({ options: { colorMode: "theme" }, env: { GO_USAGE_COLOR_MODE: "mole" } }).colorMode, "theme")
  eq(resolveOptions({}).tps, true)
  eq(resolveOptions({ options: { tps: false } }).tps, false)
  eq(resolveOptions({ options: { tps: true } }).tps, true)
  eq(resolveOptions({ env: { GO_USAGE_TPS: "0" } }).tps, false)
  eq(resolveOptions({ env: { GO_USAGE_TPS: "off" } }).tps, false)
  eq(resolveOptions({ env: { GO_USAGE_TPS: "1" } }).tps, true)
  eq(resolveOptions({}).tpsCharsPerToken, 3.5)
  eq(resolveOptions({ options: { tpsFactor: 2.4 } }).tpsCharsPerToken, 2.4)
  eq(resolveOptions({ env: { GO_USAGE_TPS_FACTOR: "2.5" } }).tpsCharsPerToken, 2.5)
  eq(resolveOptions({ env: { GO_USAGE_TPS_FACTOR: "99" } }).tpsCharsPerToken, 8)
  eq(resolveOptions({ env: { GO_USAGE_TPS_FACTOR: "x" } }).tpsCharsPerToken, 3.5)
  eq(resolveOptions({ options: { tpsFactor: 2.4 }, env: { GO_USAGE_TPS_FACTOR: "5" } }).tpsCharsPerToken, 2.4)
  eq(resolveOptions({}).cache, true)
  eq(resolveOptions({ options: { cache: false } }).cache, false)
  eq(resolveOptions({ options: { cache: true } }).cache, true)
  eq(resolveOptions({ env: { GO_USAGE_CACHE: "0" } }).cache, false)
  eq(resolveOptions({ env: { GO_USAGE_CACHE: "off" } }).cache, false)
  eq(resolveOptions({ env: { GO_USAGE_CACHE: "1" } }).cache, true)
  eq(resolveOptions({}).bridge, true)
  eq(resolveOptions({ options: { bridge: false } }).bridge, false)
  eq(resolveOptions({ options: { bridge: true } }).bridge, true)
  eq(resolveOptions({ env: { GO_USAGE_BRIDGE: "0" } }).bridge, false)
  eq(resolveOptions({ env: { GO_USAGE_BRIDGE: "no" } }).bridge, false)
  eq(resolveOptions({ env: { GO_USAGE_BRIDGE: "1" } }).bridge, true)
  eq(DEFAULT_BRIDGE_URL, "http://127.0.0.1:7331/v1/usage")
  eq(resolveOptions({}).bridgeUrl, DEFAULT_BRIDGE_URL)
  eq(resolveOptions({ options: { bridgeUrl: " http://127.0.0.1:9000/u " } }).bridgeUrl, "http://127.0.0.1:9000/u")
  eq(resolveOptions({ env: { GO_USAGE_BRIDGE_URL: "http://box:8080/u" } }).bridgeUrl, "http://box:8080/u")
  eq(resolveOptions({ options: { bridgeUrl: "http://a/u" }, env: { GO_USAGE_BRIDGE_URL: "http://b/u" } }).bridgeUrl, "http://a/u")
  eq(normalizeBridgeUrl(""), DEFAULT_BRIDGE_URL)
  eq(normalizeBridgeUrl(undefined), DEFAULT_BRIDGE_URL)
  eq(normalizeBridgeUrl(null), DEFAULT_BRIDGE_URL)
})

test("mole palette matches the other CLI plugins", () => {
  eq(MOLE_PALETTE.success, [165, 214, 167])
  eq(MOLE_PALETTE.deepGreen, [76, 175, 80])
  eq(MOLE_PALETTE.draculaPink, [255, 121, 198])
  eq(MOLE_PALETTE.warning, [255, 169, 77])
  eq(MOLE_PALETTE.error, [255, 95, 95])
  eq(MOLE_PALETTE.accent, [199, 159, 215])
  eq(MOLE_PALETTE.border, [64, 64, 64])
  eq(MOLE_PALETTE.muted, [115, 115, 115])
})

test("observable notifies subscribers and survives broken listeners", () => {
  const state = createObservable({ count: 0 })
  const seen = []
  const unsubscribe = state.subscribe((value) => {
    if (value.count === 1) throw new Error("boom")
    seen.push(value.count)
  })
  state.set({ count: 1 })
  state.set({ count: 2 })
  state.update((value) => ({ count: value.count + 1 }))
  eq(seen, [0, 2, 3])
  unsubscribe()
  state.set({ count: 9 })
  eq(seen, [0, 2, 3])
})

test("debug log is off by default and lives beside the config", () => {
  const disabled = createLogger(false, { file: path.join(HERE, "should-not-exist.log") })
  disabled.write("nope")
  eq(fs.existsSync(path.join(HERE, "should-not-exist.log")), false)
  eq(disabled.enabled, false)
  eq(logPath({}, "/home/u"), path.join("/home/u", ".config", "opencode", "plugins", "go-usage-debug.log"))
  eq(logPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/u"), path.join("/tmp/xdg", "opencode", "plugins", "go-usage-debug.log"))
})

test("browser opener is platform-aware and opt-out", () => {
  eq(openCommand("https://x", "darwin"), ["open", ["https://x"]])
  eq(openCommand("https://x", "win32"), ["cmd", ["/c", "start", "", "https://x"]])
  eq(openCommand("https://x", "linux"), ["xdg-open", ["https://x"]])
  eq(openBrowser("https://x", false), false)
  eq(openBrowser("", true), false)
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
  const url = "file:///tmp/oc-plugins/plugins/go-usage"
  const fresh = patchCliConfig('{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n', url, { options: { interval: 60 } })
  eq(fresh.config.plugins.length, 1)
  eq(fresh.config.plugins[0].package, url)
  eq(fresh.config.plugins[0].options.interval, 60)

  const existing = patchCliConfig(
    JSON.stringify({ plugins: ["opencode.example", { package: "file:///tmp/other" }] }),
    url,
    { options: { interval: 30 } },
  )
  eq(existing.config.plugins.length, 3)
  eq(existing.config.plugins[0], "opencode.example")

  const updated = patchCliConfig(existing.text, url, { options: { interval: 15 } })
  eq(updated.config.plugins.length, 3)
  eq(updated.config.plugins[2].options.interval, 15)
  eq(updated.existed, true)

  const removed = removeCliPlugin(updated.text, url)
  eq(removed.removed, true)
  eq(removed.config.plugins.length, 2)

  const untouched = removeCliPlugin(removed.text, url)
  eq(untouched.removed, false)

  const installer = fs.readFileSync(path.join(PLUGIN_DIR, "scripts/install.mjs"), "utf8")
  includes(installer, ": 300", "installer default interval must be 5 minutes")
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
  eq(pkg.name, "go-usage")
  eq(pkg.private, true)
  eq(pkg.exports["./tui"], "./tui.ts")
  eq(pkg.scripts.test, "node test/harness.mjs")
  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.ts"), "utf8")
  includes(tui, 'export { default } from "./src/entry.tsx"')
  const entry = fs.readFileSync(path.join(PLUGIN_DIR, "src/entry.tsx"), "utf8")
  includes(entry, 'id: "go-usage"')
  includes(entry, "prompt.footer.status")
  excludes(entry, "sidebar.content", "the plugin owns the prompt footer only")
  includes(entry, "resolveCommand", "no-argument /go-usage must route through resolveCommand")
  includes(entry, "createUsageFeed", "the footer needs the live speed tracker")
  includes(entry, "context.data.listen", "the speed tracker follows the runtime event stream")
  const feed = fs.readFileSync(path.join(PLUGIN_DIR, "src/usage-events.mjs"), "utf8")
  includes(feed, "createSpeedTracker", "the feed owns the live speed tracker")
  includes(feed, "createCacheTracker", "the feed owns the session cache-hit tracker")
  includes(feed, 'case "session.step.ended"', "cache counters arrive at step end")
  includes(entry, 'slash: { name: "go-usage", arguments: true }')
  includes(entry, 'slash: { name: "go-usage-login" }')
  includes(entry, 'slash: { name: "go-usage-logout" }')
  includes(entry, 'slash: { name: "go-usage-refresh" }')
  includes(entry, "go-usage.logout", "palette must keep a disconnect entry")
  includes(entry, "go-usage.refresh", "palette must keep a refresh entry")
  includes(entry, "loginEpoch += 1", "logout must invalidate in-flight logins")
  includes(entry, "suppressAdopt = true", "logout must stop re-adopting the stored session")
  includes(entry, "sessionID={slot?.sessionID}", "the footer must show only its own session's speed")
  const ui = fs.readFileSync(path.join(PLUGIN_DIR, "src/ui/line.tsx"), "utf8")
  includes(ui, "buildPromptLine")
  includes(ui, "speedForSession")
  includes(ui, "cacheForSession")
  includes(ui, "colorMode={props.colorMode}")
  includes(ui, "RGBA.fromInts")
  includes(ui, "MOLE_PALETTE")
  includes(ui, "deepGreen", "the hot tier must resolve to the deep green")
  includes(ui, "draculaPink", "the pink tier must resolve to Dracula pink")
})

test("/go-usage login shares the already-connected guard with /go-usage-login", () => {
  const entry = fs.readFileSync(path.join(PLUGIN_DIR, "src/entry.tsx"), "utf8")
  includes(entry, 'if (action === "login") return loginCommand()', "argument form must reuse the dedicated command")
  includes(entry, 'phase !== "disconnected"', "an expired session must still be able to log in again")
})

test("go-usage stays standalone (no imports from sibling plugins)", () => {
  const crossPlugin = /from\s+["'][^"']*\.\.\/\.\.\/go-usage\//
  for (const file of listFiles(PLUGIN_DIR)) {
    if (!/\.(mjs|ts|tsx)$/.test(file)) continue
    const text = fs.readFileSync(file, "utf8")
    ok(!crossPlugin.test(text), `${path.relative(PLUGIN_DIR, file)} imports the other plugin`)
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
