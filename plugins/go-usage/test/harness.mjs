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

import {
  bar,
  barText,
  displayWidth,
  formatAge,
  formatClock,
  formatMoney,
  formatReset,
  toNumber,
  toTime,
  toneForMeter,
} from "../src/format.mjs"
import { METER_KEYS, meterFromRaw, normalizeStatus } from "../src/status.mjs"
import {
  DEFAULT_BASE_URL,
  absoluteUrl,
  buildDeviceCodeRequest,
  buildRefreshRequest,
  buildStatusRequest,
  buildTokenPollRequest,
  createAuthManager,
  needsRefresh,
  parseDeviceCode,
  parseTokenOutcome,
} from "../src/auth.mjs"
import { createUsageService } from "../src/service.mjs"
import { resolveCommand } from "../src/commands.mjs"
import { clampInterval, resolveOptions } from "../src/options.mjs"
import { createObservable } from "../src/store.mjs"
import { createLogger, logPath } from "../src/log.mjs"
import { openBrowser, openCommand } from "../src/open.mjs"
import { buildDetailLines, buildSidebarModel } from "../src/model.mjs"
import { MOLE_PALETTE } from "../src/colors.mjs"
import {
  cliConfigPath,
  configDirectory,
  patchCliConfig,
  removeCliPlugin,
  sidebarHidden,
} from "../scripts/lib.mjs"

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

function flatText(lines) {
  return (lines ?? []).map((line) => line.map((segment) => segment.text).join("")).join("\n")
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

test("bar renders exactly the requested width with block characters", () => {
  eq(bar(92, 36).text, `${"█".repeat(33)}${"░".repeat(3)}`)
  eq(displayWidth(bar(92, 36).text), 36)
  eq(bar(0, 10).text, "░".repeat(10))
  eq(bar(100, 10).text, "█".repeat(10))
  eq(bar(105, 10).text, "█".repeat(10))
  eq(bar(45, 10).text, `${"█".repeat(4)}${"░".repeat(6)}`)
  eq(bar(13, 10).text, `█${"░".repeat(9)}`)
  eq(bar(99.9, 10).text, `${"█".repeat(9)}░`)
  eq(bar(-5, 10).text, "░".repeat(10))
  eq(bar(NaN, 8).text, "░".repeat(8))
  eq(barText(50, 4), `██${"░".repeat(2)}`)
})

test("bar output only ever contains fill and track", () => {
  const allowed = /^[█░]+$/
  for (let percent = 0; percent <= 130; percent += 7) {
    const shape = bar(percent, 36)
    ok(allowed.test(shape.text), `unexpected characters for ${percent}%: ${shape.text}`)
    eq(displayWidth(shape.text), 36)
    eq(shape.filled + shape.empty, shape.text)
  }
})

test("tone buckets match the console (70 / 95)", () => {
  eq(toneForMeter(0), "success")
  eq(toneForMeter(69.9), "success")
  eq(toneForMeter(70), "warning")
  eq(toneForMeter(95), "warning")
  eq(toneForMeter(95.01), "danger")
  eq(toneForMeter(120), "danger")
})

test("formatReset mirrors the console countdown", () => {
  const plus = (ms) => new Date(NOW + ms).toISOString()
  eq(formatReset(plus(31 * 60_000), NOW), "0h 31m")
  eq(formatReset(plus(12 * 3_600_000 + 12 * 60_000), NOW), "12h 12m")
  eq(formatReset(plus(9 * 86_400_000 + 14 * 3_600_000), NOW), "9d 14h")
  eq(formatReset(plus(23 * 3_600_000 + 59 * 60_000), NOW), "23h 59m")
  eq(formatReset(plus(24 * 3_600_000), NOW), "1d 0h")
  eq(formatReset(plus(1800_000), NOW), "0h 30m")
  eq(formatReset(new Date(NOW - 500_000).toISOString(), NOW), "0h 0m")
  eq(formatReset((NOW + 600_000) / 1000, NOW), "0h 10m")
  eq(formatReset(null, NOW), null)
  eq(formatReset("not a date", NOW), null)
})

test("money, age and clock formatting", () => {
  eq(formatMoney(1_200_000_000), "$12.00")
  eq(formatMoney("1104000000"), "$11.04")
  eq(formatMoney(0), "$0.00")
  eq(formatMoney(-1), "--")
  eq(formatMoney(null), "--")
  eq(formatAge(NOW, NOW), "just now")
  eq(formatAge(NOW - 12_000, NOW), "12s ago")
  eq(formatAge(NOW - 3 * 60_000, NOW), "3m ago")
  eq(formatAge(NOW - 2 * 3_600_000, NOW), "2h ago")
  eq(formatAge(0, NOW), null)
  eq(formatClock(new Date(2026, 9, 18, 22, 31, 5).getTime()), "22:31:05")
  eq(formatClock(new Date(2026, 0, 2, 3, 4, 9).getTime()), "03:04:09")
  eq(formatClock(0), null)
  eq(formatClock(null), null)
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

test("meterFromRaw mirrors console percent/badge/tone rules", () => {
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

test("normalizeStatus shapes the sidebar data", () => {
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
  eq(normalizeStatus({ ...GO_STATUS, useBalance: true }, NOW).useBalance, true)

  const noAccess = normalizeStatus({ ...GO_STATUS, access: null }, NOW)
  eq(noAccess.hasAccess, false)
  eq(noAccess.meters.map((entry) => entry.meter), [null, null, null])

  const none = normalizeStatus(null, NOW)
  eq(none.present, false)
  eq(none.meters, [])
  eq(none.plan, null)

  eq(METER_KEYS.length, 3)
})

// ---------------------------------------------------------------------------
// sidebar model
// ---------------------------------------------------------------------------

test("sidebar ready state renders the three btop meters", () => {
  const model = buildSidebarModel(goStatusView())
  const lines = model.lines.map((line) => line.map((segment) => segment.text).join(""))
  eq(lines.length, 1 + 3 * 2)
  includes(lines[0], "◈ Go usage")
  includes(lines[0], "Go")
  includes(lines[1], "Rolling")
  includes(lines[1], "92%")
  includes(lines[1], "0h 31m")
  eq(lines[2], bar(92, 36).text)
  includes(lines[3], "Weekly")
  includes(lines[3], "45%")
  includes(lines[3], "12h 12m")
  eq(lines[4], bar(45, 36).text)
  includes(lines[5], "Monthly")
  includes(lines[5], "44%")
  includes(lines[5], "9d 14h")
  excludes(lines.join("\n"), "/go-usage", "fresh data adds no footer line")
})

test("sidebar tones follow the meter percent", () => {
  const view = goStatusView()
  const lines = buildSidebarModel(view).lines
  const rollingTone = lines[1].find((segment) => segment.text.includes("92%"))
  eq(rollingTone.tone, "warning")
  const weeklyTone = lines[3].find((segment) => segment.text.includes("45%"))
  eq(weeklyTone.tone, "success")
  // mole style: fill and track share the threshold color (like sys-status)
  eq(lines[2][0].tone, "warning")
  eq(lines[2][1].tone, "warning")
  eq(lines[4][0].tone, "success")
  eq(lines[4][1].tone, "success")
})

test("bar styles match sys-status: mole tones the track, solid blanks it", () => {
  const mole = buildSidebarModel(goStatusView(), { width: 36 })
  eq(mole.lines[2].map((segment) => segment.text).join(""), bar(92, 36).text)

  const solid = buildSidebarModel(goStatusView(), { width: 36, barStyle: "solid" })
  const text = solid.lines[2].map((segment) => segment.text).join("")
  eq(text, `${"█".repeat(33)}${" ".repeat(3)}`)
  eq(solid.lines[2][0].tone, "warning")
  eq(solid.lines[2][1].tone, "faint")

  const framed = buildSidebarModel(goStatusView(), { frame: "rounded", barStyle: "solid" })
  eq(framed.lines[2].map((segment) => segment.text).join(""), `│ ${"█".repeat(29)}${" ".repeat(3)} │`)
})

test("sidebar stale/ready keeps values and flags the failure", () => {
  const model = buildSidebarModel(goStatusView({ stale: true, error: "HTTP 500" }))
  const text = flatText(model.lines)
  includes(text, "92%")
  includes(text, "stale · retrying automatically")
  eq(model.lines.length, 1 + 3 * 2 + 1)
})

test("sidebar non-ready phases render guidance", () => {
  includes(flatText(buildSidebarModel({ phase: "checking" }).lines), "not connected")
  includes(flatText(buildSidebarModel({ phase: "checking" }).lines), "/go-usage to connect")
  includes(flatText(buildSidebarModel({ phase: "loading" }).lines), "checking usage…")
  includes(flatText(buildSidebarModel({ phase: "disconnected" }).lines), "session expired")
  includes(flatText(buildSidebarModel({ phase: "disconnected" }).lines), "/go-usage to reconnect")
  includes(flatText(buildSidebarModel({ phase: "absent" }).lines), "no active Go subscription")
  const error = flatText(buildSidebarModel({ phase: "error", error: "HTTP 500" }).lines)
  includes(error, "fetch failed · HTTP 500")
  includes(error, "retrying automatically")
})

test("sidebar lines never exceed the sidebar width and never leak internals", () => {
  const views = [
    goStatusView(),
    goStatusView({ stale: true, error: "HTTP 500" }),
    { phase: "checking" },
    { phase: "loading" },
    { phase: "disconnected" },
    { phase: "absent" },
    { phase: "error", error: "a very long network failure message that should be clipped" },
  ]
  for (const view of views) {
    const text = flatText(buildSidebarModel(view).lines)
    excludes(text, "NaN")
    excludes(text, "undefined")
    excludes(text, "Infinity")
    for (const width of [36, 24, 16]) {
      for (const line of buildSidebarModel(view, { width }).lines) {
        const joined = line.map((segment) => segment.text).join("")
        ok(displayWidth(joined) <= width, `line wider than ${width}: ${joined}`)
      }
    }
  }
})

test("sidebar meters without data degrade gracefully", () => {
  const status = normalizeStatus({ product: "go", access: { meters: { fiveHour: null, week: null, month: null } } }, NOW)
  const text = flatText(buildSidebarModel({ phase: "ready", status, fetchedAt: NOW, now: NOW }).lines)
  includes(text, "Rolling")
  includes(text, "no data")
  excludes(text, "NaN")
})

test("detail dialog text covers every phase", () => {
  includes(buildDetailLines(goStatusView()).join("\n"), "Plan: Go")
  includes(buildDetailLines(goStatusView()).join("\n"), "$11.04 of $12.00")
  includes(buildDetailLines(goStatusView()).join("\n"), "resets in 0h 31m")
  includes(buildDetailLines(goStatusView()).join("\n"), "Fetched just now.")
  includes(buildDetailLines(goStatusView({ stale: true })).join("\n"), "latest refresh failed")
  includes(buildDetailLines({ phase: "checking" }).join("\n"), "/go-usage and approve")
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

test("framed sidebar draws its own border with title and clock", () => {
  const localFetched = new Date(2026, 9, 18, 22, 31, 5).getTime()
  const model = buildSidebarModel({ ...goStatusView(), fetchedAt: localFetched }, { frame: "rounded" })
  const lines = model.lines.map((line) => line.map((segment) => segment.text).join(""))
  // top border + 3 meter pairs + bottom border (no footer when fresh)
  eq(lines.length, 8)
  for (const line of lines) eq(displayWidth(line), 36, `line must be exactly 36 cells: ${line}`)
  eq(lines[0], `╭─ ◈ Go usage ${"─".repeat(10)} 22:31:05 ─╮`)
  eq(lines[7], `╰${"─".repeat(34)}╯`)
  includes(lines[1], "Rolling")
  includes(lines[1], "92%")
  includes(lines[1], "0h 31m")
  eq(lines[2], `│ ${bar(92, 32).text} │`)
  eq(lines[4], `│ ${bar(45, 32).text} │`)
  eq(lines[6], `│ ${bar(44, 32).text} │`)
  excludes(lines.join("\n"), "◈ Go usage\n", "the title must appear only in the border")
  excludes(lines.join("\n"), "/go-usage", "fresh data adds no footer line")
  for (const line of lines.slice(1, 7)) {
    ok(line.startsWith("│ "), `content lines open the border: ${line}`)
    ok(line.endsWith(" │"), `content lines close the border: ${line}`)
  }
})

test("framed sidebar without data has no clock; stale colors it", () => {
  const checking = buildSidebarModel({ phase: "checking" }, { frame: "rounded" })
  const top = checking.lines[0].map((segment) => segment.text).join("")
  eq(top, `╭─ ◈ Go usage ${"─".repeat(21)}╮`)
  excludes(top, ":")

  const localFetched = new Date(2026, 9, 18, 22, 31, 5).getTime()
  const stale = buildSidebarModel({ ...goStatusView(), fetchedAt: localFetched, stale: true }, { frame: "rounded" })
  const staleTime = stale.lines[0].find((segment) => segment.text === "22:31:05")
  eq(staleTime.tone, "warning")
  includes(flatText(stale.lines), "stale · retrying automatically")
  const fresh = buildSidebarModel({ ...goStatusView(), fetchedAt: localFetched, stale: false }, { frame: "rounded" })
  eq(fresh.lines[0].find((segment) => segment.text === "22:31:05").tone, "muted")
})

test("heavy frame uses heavy box characters", () => {
  const model = buildSidebarModel(goStatusView(), { frame: "heavy" })
  const lines = model.lines.map((line) => line.map((segment) => segment.text).join(""))
  ok(lines[0].startsWith("┏━"), lines[0])
  ok(lines[0].endsWith("━┓"), lines[0])
  ok(lines[1].startsWith("┃ "), lines[1])
  eq(lines[7], `┗${"━".repeat(34)}┛`)
  for (const line of lines) eq(displayWidth(line), 36)
})

test("header:true stays the default for unframed layouts", () => {
  includes(flatText(buildSidebarModel(goStatusView(), { width: 36 }).lines), "◈ Go usage")
  includes(flatText(buildSidebarModel(goStatusView(), { width: 36, header: true }).lines), "◈ Go usage")
  eq(buildSidebarModel(goStatusView(), { width: 36 }).lines.length, 7)
})

test("sidebar UI delegates the frame to the model", () => {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, "src/ui/sidebar.tsx"), "utf8")
  includes(source, 'frame: props.frame ?? "rounded"')
  includes(source, 'barStyle: props.barStyle ?? "mole"')
  includes(source, "colorMode={props.colorMode}")
  includes(source, "buildSidebarModel")
  excludes(source, "borderStyle", "the OpenTUI border box was replaced by the model-drawn frame")
  const modelSource = fs.readFileSync(path.join(PLUGIN_DIR, "src/model.mjs"), "utf8")
  includes(modelSource, "FRAME_CHARS")
  includes(modelSource, "formatClock")
  includes(modelSource, "barSegments")
})

test("kit resolves mole mode through sys-status's palette", () => {
  const kit = fs.readFileSync(path.join(PLUGIN_DIR, "src/ui/kit.tsx"), "utf8")
  includes(kit, 'import { RGBA } from "@opentui/core"')
  includes(kit, "MOLE_PALETTE")
  includes(kit, "RGBA.fromInts")
  includes(kit, 'colorMode = "theme"')
  includes(kit, "MOLE_RGBA.accent")
  includes(kit, "MOLE_RGBA.border")
  const entry = fs.readFileSync(path.join(PLUGIN_DIR, "src/entry.tsx"), "utf8")
  includes(entry, "colorMode={options.colorMode}")
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
  // env/option override wins over the stored org
  eq(scopedMock.calls[0].init.headers["x-org-id"], "wrk_env")
})

// ---------------------------------------------------------------------------
// options, store, log, open
// ---------------------------------------------------------------------------

test("option and env resolution", () => {
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
  eq(resolveOptions({ options: { placement: "bottom" } }).placement, "bottom")
  eq(resolveOptions({ options: { sidebar: false } }).sidebar, false)
  eq(resolveOptions({ options: { openBrowser: false } }).openBrowser, false)
  eq(resolveOptions({ env: { GO_USAGE_NO_OPEN: "1" } }).openBrowser, false)
  eq(resolveOptions({ options: { debug: true } }).debug, true)
  eq(resolveOptions({ env: { GO_USAGE_DEBUG: "1" } }).debug, true)
  eq(resolveOptions({ env: { GO_USAGE_ORG: "wrk_env" } }).orgId, "wrk_env")
  eq(resolveOptions({}).frame, "rounded")
  eq(resolveOptions({ options: { frame: "heavy" } }).frame, "heavy")
  eq(resolveOptions({ options: { frame: "none" } }).frame, "none")
  eq(resolveOptions({ env: { GO_USAGE_FRAME: "heavy" } }).frame, "heavy")
  eq(resolveOptions({ options: { frame: "wat" } }).frame, "rounded")
  eq(resolveOptions({ options: { frame: "none" }, env: { GO_USAGE_FRAME: "heavy" } }).frame, "none")
  eq(resolveOptions({}).barStyle, "mole")
  eq(resolveOptions({ options: { barStyle: "solid" } }).barStyle, "solid")
  eq(resolveOptions({ env: { GO_USAGE_BAR_STYLE: "solid" } }).barStyle, "solid")
  eq(resolveOptions({ options: { barStyle: "wat" } }).barStyle, "mole")
  eq(resolveOptions({ options: { barStyle: "mole" }, env: { GO_USAGE_BAR_STYLE: "solid" } }).barStyle, "mole")
  eq(resolveOptions({}).colorMode, "mole")
  eq(resolveOptions({ options: { colorMode: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ env: { GO_USAGE_COLOR_MODE: "theme" } }).colorMode, "theme")
  eq(resolveOptions({ options: { colorMode: "wat" } }).colorMode, "mole")
  eq(resolveOptions({ options: { colorMode: "theme" }, env: { GO_USAGE_COLOR_MODE: "mole" } }).colorMode, "theme")
})

test("mole palette matches sys-status exactly", () => {
  eq(MOLE_PALETTE.success, [165, 214, 167])
  eq(MOLE_PALETTE.warning, [255, 169, 77])
  eq(MOLE_PALETTE.error, [255, 95, 95])
  eq(MOLE_PALETTE.accent, [199, 159, 215])
  eq(MOLE_PALETTE.border, [64, 64, 64])
  eq(MOLE_PALETTE.muted, [115, 115, 115])
  for (const [tone, rgb] of Object.entries(MOLE_PALETTE)) {
    eq(rgb.length, 3, `${tone} must be an RGB triplet`)
    for (const channel of rgb) ok(Number.isInteger(channel) && channel >= 0 && channel <= 255, `${tone} channel out of range: ${channel}`)
  }
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
  eq(sidebarHidden({ session: { sidebar: "hide" } }), true)
  eq(sidebarHidden({ session: { sidebar: "auto" } }), false)
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
  includes(entry, "sidebar.content")
  includes(entry, 'slash: { name: "go-usage", arguments: true }')
  includes(entry, "resolveCommand", "no-argument /go-usage must route through resolveCommand")
  includes(entry, 'slash: { name: "go-usage-login" }', "dedicated /go-usage-login slash command")
  includes(entry, 'slash: { name: "go-usage-logout" }', "dedicated /go-usage-logout slash command")
  includes(entry, 'slash: { name: "go-usage-refresh" }', "dedicated /go-usage-refresh slash command")
  includes(entry, "go-usage.logout", "palette must keep a disconnect entry")
  includes(entry, "go-usage.refresh", "palette must keep a refresh entry")
})

test("logout cannot be resurrected by a pending login or stale storage", () => {
  const entry = fs.readFileSync(path.join(PLUGIN_DIR, "src/entry.tsx"), "utf8")
  includes(entry, "loginEpoch += 1", "logout must invalidate in-flight logins")
  includes(entry, "suppressAdopt = true", "logout must stop re-adopting the stored session")
  includes(entry, "suppressAdopt = false", "a fresh login must re-enable adoption")
  includes(entry, "auth.logout()", "logout must clear the auth manager")
  includes(entry, "updateCacheDoc", "logout must clear the cached payload")
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
