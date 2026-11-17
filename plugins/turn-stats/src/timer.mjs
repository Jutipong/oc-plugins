// turn-stats — turn timer (pure).
//
// A "turn" is one `session.execution.started` → `succeeded` / `failed` /
// `interrupted` cycle: wall-clock from the moment the runtime starts the turn
// until it ends, including tool calls, retries and child sessions. The
// tracker freezes the duration at the end so the line can keep showing the
// last turn's time until the next turn starts.

import { toNumber } from "./format.mjs"

export const MAX_TRACKED_SESSIONS = 32
/** Field width that keeps the duration from shifting the row. */
export const TURN_BADGE_WIDTH = 6

/**
 * Duration -> fixed-width clock label: `00:00` / `00:45` / `01:05` / `10:45` /
 * `75:12`, padded to `TURN_BADGE_WIDTH` (`" 00:45"`, `" 75:12"`). Minutes keep
 * counting past 99 so a long turn never changes the field width; a missing or
 * unusable duration reads as `00:00`.
 */
export function formatTurn(ms) {
  const value = toNumber(ms)
  const total = value == null || value < 0 ? 0 : Math.floor(value / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`.padStart(TURN_BADGE_WIDTH)
}

/**
 * Per-session turn clock.
 *
 * start(sid, at) — `session.execution.started`: begin (or keep) counting. A
 *   replayed start while the turn is already running is ignored, so a durable
 *   event cannot reset a live timer.
 * end(sid, at)   — `execution.succeeded/failed/interrupted` (or `idle`): freeze
 *   the elapsed time; it stays on the line until the next turn starts.
 * snapshot(at)   — `{ [sessionID]: { running, ms } }` for sessions with a
 *   running or finished turn; idle sessions with no turn yet are omitted.
 */
export function createTurnTimer({ maxSessions = MAX_TRACKED_SESSIONS } = {}) {
  const sessions = new Map()

  function touch(sid) {
    let bucket = sessions.get(sid)
    if (bucket) {
      // Re-insert so the Map order stays "least recently used first".
      sessions.delete(sid)
    } else {
      bucket = { startAt: 0, lastMs: null, running: false }
    }
    sessions.set(sid, bucket)
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
    return bucket
  }

  return {
    start(sid, at = Date.now()) {
      if (!sid) return
      const bucket = touch(sid)
      if (bucket.running) return
      bucket.running = true
      bucket.startAt = at
    },

    end(sid, at = Date.now()) {
      if (!sid) return
      const bucket = sessions.get(sid)
      if (!bucket || !bucket.running) return
      bucket.running = false
      bucket.lastMs = Math.max(0, at - bucket.startAt)
      touch(sid)
    },

    snapshot(at = Date.now()) {
      const output = {}
      for (const [sid, bucket] of sessions) {
        if (bucket.running) output[sid] = { running: true, ms: Math.max(0, at - bucket.startAt) }
        else if (bucket.lastMs != null) output[sid] = { running: false, ms: bucket.lastMs }
      }
      return output
    },

    dispose() {
      sessions.clear()
    },
  }
}
