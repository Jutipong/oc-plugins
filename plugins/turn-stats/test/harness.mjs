// turn-stats — offline harness.
//
// Pure Node test runner: no OpenTUI, no Solid, no network. Run with
// `node test/harness.mjs` (or `bun run test`) and expect:
//
//   ALL TESTS PASSED (N assertions)

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { displayWidth, formatCacheBadge, formatTps, formatTpsField, toNumber, toneForCacheHit, toneForTps, truncate } from "../src/format.mjs"
import { clampCharsPerToken, createSpeedTracker } from "../src/tps.mjs"
import { cacheHitPercent, createCacheTracker, readTokens } from "../src/cache.mjs"
import { SPEED_TICK_MS, createUsageFeed } from "../src/usage-events.mjs"
import { TURN_BADGE_WIDTH, createTurnTimer, formatTurn } from "../src/timer.mjs"
import { buildPromptLine, cacheForSession, speedForSession, turnForSession } from "../src/model.mjs"
import { resolveOptions } from "../src/options.mjs"
import { createObservable } from "../src/store.mjs"
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

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

test("truncate is unicode-aware and displayWidth counts cells", () => {
  eq(truncate("hello", 10), "hello")
  eq(truncate("hello", 4), "hel…")
  eq(truncate("hello", 1), "…")
  eq(displayWidth("▤ 87%"), 5)
  eq(displayWidth(""), 0)
})

test("toNumber accepts the wire encodings", () => {
  eq(toNumber("42"), 42)
  eq(toNumber(42n), 42)
  eq(toNumber(""), null)
  eq(toNumber("junk"), null)
  eq(toNumber(null), null)
})

test("speed label keeps one decimal below 10 and rounds above it", () => {
  eq(formatTps(null), "—")
  eq(formatTps(0), "0")
  eq(formatTps(0.44), "0.4")
  eq(formatTps(9.96), "10")
  eq(formatTps(120), "120")
})

test("speed buckets: >= 200 pink, >= 150 hot, >= 100 green, >= 60 amber, below that red", () => {
  eq(toneForTps(0), "danger")
  eq(toneForTps(60), "warning")
  eq(toneForTps(100), "success")
  eq(toneForTps(150), "hot")
  eq(toneForTps(200), "pink")
})

test("chars-per-token factor clamps to 1-8 with a 3.5 default", () => {
  eq(clampCharsPerToken(undefined), 3.5)
  eq(clampCharsPerToken("2.4"), 2.4)
  eq(clampCharsPerToken(0), 3.5)
  eq(clampCharsPerToken("x"), 3.5)
  eq(clampCharsPerToken(99), 8)
})

test("speed and cache fields keep a fixed width so the row never shifts", () => {
  eq(formatTpsField(0), "  0")
  eq(formatTpsField(7.4), "7.4")
  eq(formatTpsField(106), "106")
  eq(displayWidth(formatTpsField(5)), displayWidth(formatTpsField(555)))

  eq(formatCacheBadge(null), "   —")
  eq(formatCacheBadge(3), "  3%")
  eq(formatCacheBadge(87), " 87%")
  eq(formatCacheBadge(100), "100%")
  eq(formatCacheBadge(140), "100%")
  eq(formatCacheBadge("x"), "   —")
  eq(displayWidth(formatCacheBadge(3)), displayWidth(formatCacheBadge(87)))
  eq(displayWidth(formatCacheBadge(null)), displayWidth(formatCacheBadge(100)))

  eq(toneForCacheHit(100), "success")
  eq(toneForCacheHit(80), "success")
  eq(toneForCacheHit(79.9), "base")
  eq(toneForCacheHit(50), "base")
  eq(toneForCacheHit(49.9), "warning")
  eq(toneForCacheHit(null), "warning")
})

// ---------------------------------------------------------------------------
// turn timer
// ---------------------------------------------------------------------------

test("formatTurn renders a fixed-width MM:SS clock", () => {
  eq(TURN_BADGE_WIDTH, 6)
  eq(formatTurn(null), " 00:00")
  eq(formatTurn(-5), " 00:00")
  eq(formatTurn("x"), " 00:00")
  eq(formatTurn(0), " 00:00")
  eq(formatTurn(4_500), " 00:04")
  eq(formatTurn(45_000), " 00:45")
  eq(formatTurn(59_900), " 00:59")
  eq(formatTurn(60_000), " 01:00")
  eq(formatTurn(65_000), " 01:05")
  eq(formatTurn(645_000), " 10:45")
  eq(formatTurn(3_600_000), " 60:00")
  eq(formatTurn(3_720_000), " 62:00")
  eq(formatTurn(39_960_000), "666:00")
  for (const ms of [0, 45_000, 645_000, 3_720_000]) eq(displayWidth(formatTurn(ms)), TURN_BADGE_WIDTH)
})

test("turn timer counts a running turn and freezes the last duration", () => {
  const timer = createTurnTimer()
  eq(timer.snapshot(1_000), {})

  timer.start("s1", 1_000)
  eq(timer.snapshot(46_000), { s1: { running: true, ms: 45_000 } })

  timer.end("s1", 61_000)
  eq(timer.snapshot(90_000), { s1: { running: false, ms: 60_000 } })

  // The frozen value stays until the next turn replaces it.
  timer.start("s1", 100_000)
  eq(timer.snapshot(100_500), { s1: { running: true, ms: 500 } })
  timer.end("s1", 105_000)
  eq(timer.snapshot(200_000), { s1: { running: false, ms: 5_000 } })
  timer.dispose()
  eq(timer.snapshot(200_000), {})
})

test("turn timer ignores a replayed start and an end without a start", () => {
  const timer = createTurnTimer()
  timer.end("s1", 5_000) // no turn seen: nothing to freeze
  eq(timer.snapshot(5_000), {})

  timer.start("s1", 1_000)
  timer.start("s1", 30_000) // durable replay mid-turn: the clock is not reset
  eq(timer.snapshot(46_000), { s1: { running: true, ms: 45_000 } })

  timer.end("s1", 50_000)
  timer.end("s1", 60_000) // a second end does not move the frozen value
  eq(timer.snapshot(70_000), { s1: { running: false, ms: 49_000 } })
  timer.dispose()
})

test("turn timer keeps sessions apart and forgets the least recently used", () => {
  const timer = createTurnTimer({ maxSessions: 2 })
  timer.start("a", 0)
  timer.start("b", 0)
  timer.end("a", 1_000) // ending re-touches "a", so "b" is the oldest
  timer.start("c", 0) // evicts "b"
  eq(Object.keys(timer.snapshot(1_000)).sort(), ["a", "c"])

  timer.start("b", 2_000) // evicts "a"; the next insert evicts "c"
  timer.start("d", 2_000)
  eq(Object.keys(timer.snapshot(2_500)).sort(), ["b", "d"])
  timer.dispose()
})

// ---------------------------------------------------------------------------
// speed tracker
// ---------------------------------------------------------------------------

test("speed tracker converts a delta window into tokens/second", () => {
  const tracker = createSpeedTracker({ charsPerToken: 4, windowMs: 2000, freshMs: 1500, minSpanMs: 500 })
  tracker.start("s1", 0)
  tracker.push("s1", 40, 1000) // 10 tokens
  tracker.push("s1", 40, 1500) // 20 tokens over a 500 ms window
  eq(tracker.snapshot(1500), { s1: 40 })

  tracker.push("s1", 400, 2000) // 120 tokens over 1000 ms
  eq(tracker.snapshot(2000), { s1: 120 })

  // A quiet session hides after the freshness window instead of showing stale speed.
  eq(tracker.snapshot(3501), {})
  tracker.dispose()
})

test("speed tracker isolates sessions, resets on start and forgets on end", () => {
  const tracker = createSpeedTracker({ charsPerToken: 4 })
  tracker.start("a", 0)
  tracker.start("b", 0)
  tracker.push("a", 80, 1000)
  tracker.push("b", 40, 1000)
  eq(tracker.snapshot(1000), { a: 40, b: 20 })

  tracker.start("a", 1200) // new step: old deltas no longer count
  tracker.push("a", 40, 1500)
  eq(tracker.snapshot(1500), { a: 20, b: 20 })

  tracker.end("a")
  eq(tracker.snapshot(1500), { b: 20 })
  tracker.dispose()
})

// ---------------------------------------------------------------------------
// cache tracker
// ---------------------------------------------------------------------------

test("cache hit counts cached reads over read + fresh input", () => {
  eq(readTokens({ input: 100, cache: { read: 900, write: 50 } }), { input: 100, output: 0, read: 900, write: 50 })
  eq(readTokens({ input: "x", cache: { read: -5 } }), { input: 0, output: 0, read: 0, write: 0 })

  eq(cacheHitPercent({ input: 1000, cache: { read: 9000 } }), 90)
  eq(cacheHitPercent({ input: 0, cache: { read: 9000 } }), 100)
  eq(cacheHitPercent({ input: 100, cache: { read: 0 } }), 0)
  eq(cacheHitPercent({ input: 1, cache: { read: 999 } }), 99) // floor: never claim 100 by rounding
  eq(cacheHitPercent({ input: 100, cache: { read: 100, write: 800 } }), 50) // writes are not hits
  eq(cacheHitPercent({}), null)
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
  tracker.dispose()
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
  eq(SPEED_TICK_MS, 500)
  feed.dispose()
})

test("usage feed starts the turn clock on execution.started only", () => {
  const turns = []
  let fakeNow = 0
  const feed = createUsageFeed({ directory: "/work", now: () => fakeNow, onTurn: (next) => turns.push(next) })

  feed.onEvent(usageEvent("session.step.started", { sessionID: "ses_a" }))
  eq(turns, []) // a step inside a turn does not start the clock

  feed.onEvent(usageEvent("session.execution.started", { sessionID: "ses_a" }))
  eq(turns.length, 1)
  eq(turns[0].ses_a.running, true)

  // The published snapshot is stable until the visible second changes.
  feed.tick()
  feed.tick()
  eq(turns.length, 1)

  fakeNow = 45_400
  feed.tick()
  eq(turns.length, 2)
  eq(turns[1].ses_a, { running: true, ms: 45_400 })

  fakeNow = 61_000
  feed.onEvent(usageEvent("session.execution.succeeded", { sessionID: "ses_a" }))
  eq(turns.length, 3)
  eq(turns[2].ses_a, { running: false, ms: 61_000 })
  feed.tick()
  eq(turns.length, 3)
  feed.dispose()
})

test("usage feed keeps a step start from resetting a running turn", () => {
  const turns = []
  let fakeNow = 0
  const feed = createUsageFeed({ now: () => fakeNow, onTurn: (next) => turns.push(next) })
  feed.onEvent(usageEvent("session.execution.started", { sessionID: "ses_a" }))
  fakeNow = 45_000
  feed.tick()
  eq(turns.at(-1).ses_a.ms, 45_000)

  // A second step inside the same turn restarts the speed window only.
  feed.onEvent(usageEvent("session.step.started", { sessionID: "ses_a" }))
  eq(turns.length, 2) // same visible second: nothing republished
  fakeNow = 46_000
  feed.tick()
  eq(turns.at(-1).ses_a, { running: true, ms: 46_000 })
  feed.dispose()
})

test("usage feed accumulates cache counters and skips replayed steps", () => {
  const caches = []
  const feed = createUsageFeed({ directory: "/work", onCache: (next) => caches.push(next) })
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

test("usage feed ignores other directories and unrelated events", () => {
  const speeds = []
  const caches = []
  const turns = []
  const feed = createUsageFeed({
    directory: "/work",
    onSpeed: (next) => speeds.push(next),
    onCache: (next) => caches.push(next),
    onTurn: (next) => turns.push(next),
  })
  feed.onEvent(usageEvent("session.execution.started", { sessionID: "ses_a" }, "/elsewhere"))
  feed.onEvent(usageEvent("session.text.delta", { sessionID: "ses_a", delta: "zzzz" }, "/elsewhere"))
  feed.onEvent(usageEvent("session.step.ended", { sessionID: "ses_a", tokens: { input: 1, cache: { read: 1 } } }, "/elsewhere"))
  feed.tick()
  eq(speeds, [])
  eq(caches, [])
  eq(turns, [])

  feed.onEvent(null)
  feed.onEvent({})
  feed.onEvent({ details: { type: "session.text.delta" } })
  feed.onEvent(usageEvent("session.updated", { sessionID: "ses_a" }))
  feed.onEvent(usageEvent("session.text.delta", { delta: "no session id" }))
  eq(speeds, [])
  eq(caches, [])
  eq(turns, [])
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

// ---------------------------------------------------------------------------
// prompt line model
// ---------------------------------------------------------------------------

const FULL_VIEW = { cache: { percent: 87 }, speed: 106, turn: { running: true, ms: 45_000 } }

test("prompt line renders the turn clock, cache and speed with icons and tones", () => {
  const line = buildPromptLine(FULL_VIEW)
  eq(flatText(line), "⏱ 00:45 · ▤ 87% · ⚡106t/s")
  eq(line.map((segment) => segment.text), ["⏱", " 00:45", " · ", "▤", " 87%", " · ", "⚡", "106", "t/s"])
  eq(line.map((segment) => segment.tone), [
    "muted",
    "base",
    "faint",
    "muted",
    "success",
    "faint",
    "muted",
    "success",
    "muted",
  ])
})

test("prompt line shows muted placeholders before the first step and turn", () => {
  const line = buildPromptLine({ cache: null, speed: null, turn: null })
  eq(flatText(line), "⏱ 00:00 · ▤   — · ⚡  0t/s")
  eq(line[1].tone, "muted")
  eq(line[4].tone, "muted")
  eq(line[7].tone, "muted")

  const lowHit = buildPromptLine({ cache: { percent: 12 }, speed: 70.4, turn: { running: false, ms: 65_000 } })
  eq(flatText(lowHit), "⏱ 01:05 · ▤ 12% · ⚡ 70t/s")
  eq(lowHit[1].tone, "muted") // a finished turn stays muted
  eq(lowHit[4].tone, "warning")
  eq(lowHit[7].tone, "warning")
})

test("prompt line picks only the rendering session's own values", () => {
  const speeds = { ses_a: 45, ses_b: 8.4 }
  eq(speedForSession(speeds, "ses_a"), 45)
  eq(speedForSession(speeds, "ses_c"), null)
  eq(speedForSession(speeds, undefined), null)
  eq(speedForSession({ ses_a: 0 }, "ses_a"), null)

  const caches = { ses_a: { percent: 87 }, ses_b: { percent: 12 } }
  eq(cacheForSession(caches, "ses_a"), { percent: 87 })
  eq(cacheForSession(caches, "ses_c"), null)
  eq(cacheForSession({ ses_a: 87 }, "ses_a"), null)

  const turns = { ses_a: { running: true, ms: 45_000 }, ses_b: { running: false, ms: 5_000 } }
  eq(turnForSession(turns, "ses_a"), { running: true, ms: 45_000 })
  eq(turnForSession(turns, "ses_b"), { running: false, ms: 5_000 })
  eq(turnForSession(turns, "ses_c"), null)
  eq(turnForSession({ ses_a: 45 }, "ses_a"), null)
  eq(turnForSession(undefined, "ses_a"), null)
})

test("prompt line keeps one width across every value change", () => {
  const widths = [3, 45, 100, null].map(
    (percent) => displayWidth(flatText(buildPromptLine({ cache: { percent }, speed: 5, turn: { running: true, ms: 5_000 } }))),
  )
  eq(new Set(widths).size, 1)

  const speeds = [5, 45, 555].map(
    (speed) => displayWidth(flatText(buildPromptLine({ cache: { percent: 87 }, speed, turn: { running: true, ms: 5_000 } }))),
  )
  eq(new Set(speeds).size, 1)

  const turns = [5_000, 65_000, 645_000, 3_720_000].map(
    (ms) => displayWidth(flatText(buildPromptLine({ cache: { percent: 87 }, speed: 5, turn: { running: true, ms } }))),
  )
  eq(new Set(turns).size, 1)
})

test("prompt line drops the speed field first, then cache, then the clock", () => {
  eq(flatText(buildPromptLine(FULL_VIEW, { width: 24 })), "⏱ 00:45 · ▤ 87%")
  eq(flatText(buildPromptLine(FULL_VIEW, { width: 15 })), "⏱ 00:45 · ▤ 87%")
  eq(flatText(buildPromptLine(FULL_VIEW, { width: 14 })), "⏱ 00:45")
  eq(flatText(buildPromptLine(FULL_VIEW, { width: 8 })), "⏱ 00:45")
  eq(displayWidth(flatText(buildPromptLine(FULL_VIEW, { width: 8 }))), 7)
})

test("prompt line never exceeds the requested width and never leaks internals", () => {
  const views = [
    FULL_VIEW,
    { cache: null, speed: null, turn: null },
    { cache: { percent: 3 }, speed: 4.2, turn: { running: false, ms: 0 } },
    { cache: { percent: 100 }, speed: 999, turn: { running: true, ms: 39_960_000 } },
    { cache: { percent: "x" }, speed: "x", turn: { running: true, ms: "x" } },
  ]
  for (const view of views) {
    const text = flatText(buildPromptLine(view))
    excludes(text, "NaN")
    excludes(text, "undefined")
    excludes(text, "Infinity")
    excludes(text, "[", "the line has no brackets")
    excludes(text, "]", "the line has no brackets")
    for (const width of [45, 24, 16, 8]) {
      const line = buildPromptLine(view, { width })
      const flat = flatText(line)
      ok(displayWidth(flat) <= width, `line wider than ${width}: ${flat}`)
      ok(!flat.startsWith(" "), `line must not start with padding: ${flat}`)
      ok(!flat.endsWith(" "), `line must not end with padding: ${flat}`)
    }
  }
})

// ---------------------------------------------------------------------------
// options, store, log, palette
// ---------------------------------------------------------------------------

test("option and env resolution uses TURN_STATS_*", () => {
  eq(resolveOptions({}).colorMode, "mole")
  eq(resolveOptions({ options: { colorMode: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ env: { TURN_STATS_COLOR_MODE: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ options: { colorMode: "wat" } }).colorMode, "mole")
  eq(resolveOptions({ options: { colorMode: "theme" }, env: { TURN_STATS_COLOR_MODE: "mole" } }).colorMode, "theme")

  eq(resolveOptions({}).charsPerToken, 3.5)
  eq(resolveOptions({ options: { tpsFactor: 2.4 } }).charsPerToken, 2.4)
  eq(resolveOptions({ env: { TURN_STATS_TPS_FACTOR: "2.5" } }).charsPerToken, 2.5)
  eq(resolveOptions({ env: { TURN_STATS_TPS_FACTOR: "99" } }).charsPerToken, 8)
  eq(resolveOptions({ options: { tpsFactor: 2.4 }, env: { TURN_STATS_TPS_FACTOR: "5" } }).charsPerToken, 2.4)

  eq(resolveOptions({}).debug, false)
  eq(resolveOptions({ options: { debug: true } }).debug, true)
  eq(resolveOptions({ env: { TURN_STATS_DEBUG: "1" } }).debug, true)
  eq(resolveOptions({ env: { TURN_STATS_DEBUG: "no" } }).debug, false)
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
  eq(logPath({}, "/home/u"), path.join("/home/u", ".config", "opencode", "plugins", "turn-stats-debug.log"))
  eq(logPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/u"), path.join("/tmp/xdg", "opencode", "plugins", "turn-stats-debug.log"))
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
  const url = "file:///tmp/oc-plugins/plugins/turn-stats"
  const fresh = patchCliConfig('{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n', url)
  eq(fresh.config.plugins.length, 1)
  eq(fresh.config.plugins[0], { package: url })

  const existing = patchCliConfig(JSON.stringify({ plugins: ["opencode.example", { package: "file:///tmp/other" }] }), url)
  eq(existing.config.plugins.length, 3)
  eq(existing.config.plugins[0], "opencode.example")

  const updated = patchCliConfig(existing.text, url)
  eq(updated.config.plugins.length, 3)
  eq(updated.existed, true)

  const removed = removeCliPlugin(updated.text, url)
  eq(removed.removed, true)
  eq(removed.config.plugins.length, 2)

  const untouched = removeCliPlugin(removed.text, url)
  eq(untouched.removed, false)

  const installer = fs.readFileSync(path.join(PLUGIN_DIR, "scripts/install.mjs"), "utf8")
  includes(installer, "cli.json")
  includes(installer, "--remove")
  excludes(installer, "interval", "turn-stats has no polling interval")
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
  eq(pkg.name, "turn-stats")
  eq(pkg.private, true)
  eq(pkg.main, "tui.ts")
  eq(pkg.exports["./tui"], "./tui.ts")
  eq(pkg.scripts.test, "node test/harness.mjs")

  const tui = fs.readFileSync(path.join(PLUGIN_DIR, "tui.ts"), "utf8")
  includes(tui, 'export { default } from "./src/entry.tsx"')

  const entry = fs.readFileSync(path.join(PLUGIN_DIR, "src/entry.tsx"), "utf8")
  includes(entry, 'id: "turn-stats"')
  includes(entry, 'append: "session.composer.top"')
  excludes(entry, "prompt.footer.status", "the line belongs above the prompt, not in the footer")
  includes(entry, "createUsageFeed", "the line needs the live meters")
  includes(entry, "context.data.listen", "the meters follow the runtime event stream")
  includes(entry, "sessionID={slot?.sessionID}", "the line must show only its own session")
  includes(entry, "SPEED_TICK_MS")

  const ui = fs.readFileSync(path.join(PLUGIN_DIR, "src/ui/line.tsx"), "utf8")
  includes(ui, "buildPromptLine")
  includes(ui, "speedForSession")
  includes(ui, "cacheForSession")
  includes(ui, "turnForSession")
  includes(ui, "justifyContent")
  includes(ui, "flex-end")
  includes(ui, 'wrapMode="none"')
  includes(ui, "colorMode={props.colorMode}")
  includes(ui, "RGBA.fromInts")
  includes(ui, "MOLE_PALETTE")
  includes(ui, "deepGreen", "the hot tier must resolve to the deep green")
  includes(ui, "draculaPink", "the pink tier must resolve to Dracula pink")

  const feed = fs.readFileSync(path.join(PLUGIN_DIR, "src/usage-events.mjs"), "utf8")
  includes(feed, "createSpeedTracker")
  includes(feed, "createCacheTracker")
  includes(feed, "createTurnTimer")
  includes(feed, 'case "session.execution.started"', "the turn clock starts with the turn")
  includes(feed, 'case "session.step.ended"', "cache counters arrive at step end")
})

test("turn-stats stays standalone (no imports from sibling plugins)", () => {
  const crossPlugin = /from\s+["'][^"']*\.\.\/\.\.\/(go-usage|system-status|esp-buddy)\//
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
