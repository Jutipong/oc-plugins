// turn-stats — view state -> the right-aligned line above the prompt.
//
// One short row: `⏱ 00:45 · ▤ 87% · ⚡103t/s` — the current/last turn time,
// session cache hit and live output speed, with per-field tones and faint
// separators. No frame, no brackets. Every number is padded to a fixed width
// so a value change never shifts the row. Pure so the harness can assert every
// state.

import {
  displayWidth,
  formatCacheBadge,
  formatTpsField,
  toneForCacheHit,
  toneForTps,
  toNumber,
  truncate,
} from "./format.mjs"
import { formatTurn } from "./timer.mjs"

const LINE_WIDTH = 45

function seg(text, tone = "base") {
  return { text: String(text ?? ""), tone }
}

function lineWidth(line) {
  return (line ?? []).reduce((width, item) => width + displayWidth(item.text), 0)
}

function clipLine(line, width) {
  const output = []
  let remaining = width
  for (const item of line ?? []) {
    if (remaining <= 0) break
    const text = truncate(item.text, remaining)
    if (!text) continue
    output.push({ ...item, text })
    remaining -= displayWidth(text)
  }
  return output
}

/**
 * Join field groups with their own faint separators. Each group is a list of
 * segments so an icon and its value can carry different tones.
 */
function groupsToLine(groups, count = groups.length) {
  const line = []
  groups.slice(0, count).forEach((group, index) => {
    if (index > 0) line.push(seg(group.sep ?? " · ", "faint"))
    line.push(...group.parts)
  })
  return line
}

/**
 * Fit the fields without brackets: drop trailing groups whole when the row is
 * narrow; if even one field overflows, truncate the line as a last resort.
 */
function fitLine(groups, budget) {
  for (let count = groups.length; count >= 1; count -= 1) {
    const line = groupsToLine(groups, count)
    if (lineWidth(line) <= budget) return line
  }
  return clipLine(groupsToLine(groups), budget)
}

/**
 * Pick the live speed for the session the line is rendering. The tracker
 * publishes one value per session; a line only shows its own session.
 */
export function speedForSession(speeds, sessionID) {
  if (!speeds || !sessionID) return null
  const value = toNumber(speeds[sessionID])
  return value != null && value > 0 ? value : null
}

/**
 * Pick the cache stats for the session the line is rendering. `null` means
 * "this session has no counters yet".
 */
export function cacheForSession(caches, sessionID) {
  if (!caches || !sessionID) return null
  const entry = caches[sessionID]
  return entry && typeof entry === "object" ? entry : null
}

/**
 * Pick the turn clock for the session the line is rendering.
 * `null` means "no turn seen yet in this session".
 */
export function turnForSession(turns, sessionID) {
  if (!turns || !sessionID) return null
  const entry = turns[sessionID]
  if (!entry || typeof entry !== "object") return null
  const ms = toNumber(entry.ms)
  if (ms == null) return null
  return { running: entry.running === true, ms }
}

/** `▤ 87%` — fixed width so the field never shifts the row. */
function cacheGroup(cache) {
  const percent = toNumber(cache?.percent)
  return {
    sep: " · ",
    parts: [
      seg("▤", "muted"),
      seg(formatCacheBadge(percent), percent == null ? "muted" : toneForCacheHit(percent)),
    ],
  }
}

/** `⚡103t/s` — the number padded to a fixed width while generating. */
function speedGroup(speed) {
  const value = toNumber(speed)
  const shown = value != null && value > 0 ? value : 0
  return {
    sep: " · ",
    parts: [
      seg("⚡", "muted"),
      seg(formatTpsField(shown), shown > 0 ? toneForTps(shown) : "muted"),
      seg("t/s", "muted"),
    ],
  }
}

/** `⏱ 00:45` — live while the turn runs, muted once it ends. */
function turnGroup(turn) {
  const ms = toNumber(turn?.ms)
  return {
    sep: " · ",
    parts: [seg("⏱", "muted"), seg(formatTurn(ms), turn?.running ? "base" : "muted")],
  }
}

/**
 * `session.composer.top` line.
 *
 * view: { speed, cache, turn }
 *   speed: live tokens/second while this session is generating, else null
 *   cache: `{ percent }` for this session, `null` when it has no counters yet
 *   turn:  `{ running, ms }` for this session, `null` before its first turn
 *
 * options:
 *   width — max cells (default 45)
 */
export function buildPromptLine(view = {}, options = {}) {
  const width = Math.max(8, Math.round(options.width ?? LINE_WIDTH))
  const groups = [turnGroup(view.turn), cacheGroup(view.cache), speedGroup(view.speed)]
  return fitLine(groups, width)
}
