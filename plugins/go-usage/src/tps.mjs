// go-usage — live output-speed tracker (tokens per second), pure.
//
// The runtime exposes text/reasoning deltas while a step streams, but no
// token counters until the step ends (verified by probe on 2.2.5). The
// tracker therefore converts the delta characters of a sliding window into
// an estimated tokens/second value; the chars-per-token factor is
// configurable because Thai text packs far fewer characters per token than
// English (~2.4 vs ~3.6 in the probe).

export const DEFAULT_CHARS_PER_TOKEN = 3.5
export const MIN_CHARS_PER_TOKEN = 1
export const MAX_CHARS_PER_TOKEN = 8
export const SPEED_WINDOW_MS = 2000
export const SPEED_FRESH_MS = 1500
export const SPEED_MIN_SPAN_MS = 500
export const MAX_TRACKED_SESSIONS = 32

/** Chars-per-token factor: 1-8, default 3.5 when unusable. */
export function clampCharsPerToken(value, fallback = DEFAULT_CHARS_PER_TOKEN) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < MIN_CHARS_PER_TOKEN) return fallback
  return Math.min(MAX_CHARS_PER_TOKEN, number)
}

/** One decimal is plenty for a footer meter. */
function roundRate(value) {
  return Math.round(value * 10) / 10
}

/**
 * Sliding-window speed meter, one bucket per session.
 *
 * start(sid)            — a new step/turn began: drop old deltas.
 * push(sid, chars, at)  — one streamed delta (text or reasoning).
 * end(sid)              — the turn ended: forget the session.
 * snapshot(at)          — `{ [sessionID]: tps }` for sessions that streamed
 *                          within `freshMs`; ended or quiet sessions are
 *                          omitted so the footer hides instead of lying.
 */
export function createSpeedTracker({
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
  windowMs = SPEED_WINDOW_MS,
  freshMs = SPEED_FRESH_MS,
  minSpanMs = SPEED_MIN_SPAN_MS,
  maxSessions = MAX_TRACKED_SESSIONS,
} = {}) {
  const factor = clampCharsPerToken(charsPerToken)
  const sessions = new Map()

  function ensure(sid, at) {
    let bucket = sessions.get(sid)
    if (!bucket) {
      bucket = { events: [], lastAt: at }
      sessions.set(sid, bucket)
      if (sessions.size > maxSessions) {
        let oldestKey = null
        let oldestAt = Infinity
        for (const [key, value] of sessions) {
          if (value.lastAt < oldestAt) {
            oldestAt = value.lastAt
            oldestKey = key
          }
        }
        if (oldestKey !== null) sessions.delete(oldestKey)
      }
    }
    return bucket
  }

  function rateOf(bucket, at) {
    const floor = at - windowMs
    const events = bucket.events.filter((event) => event.at >= floor)
    if (events.length === 0) return null
    const chars = events.reduce((total, event) => total + event.chars, 0)
    const first = events[0]
    const last = events[events.length - 1]
    const span = Math.max(minSpanMs, last.at - first.at)
    return (chars / factor / span) * 1000
  }

  return {
    start(sid, at = Date.now()) {
      if (!sid) return
      const bucket = ensure(sid, at)
      bucket.events = []
      bucket.lastAt = at
    },

    push(sid, chars, at = Date.now()) {
      if (!sid) return
      const amount = Number(chars)
      if (!Number.isFinite(amount) || amount <= 0) return
      const bucket = ensure(sid, at)
      bucket.events.push({ at, chars: amount })
      bucket.lastAt = at
      const floor = at - windowMs
      if (bucket.events.length > 64) {
        bucket.events = bucket.events.filter((event) => event.at >= floor)
      }
    },

    end(sid) {
      if (sid) sessions.delete(sid)
    },

    snapshot(at = Date.now()) {
      const output = {}
      for (const [sid, bucket] of [...sessions]) {
        if (at - bucket.lastAt > freshMs) {
          sessions.delete(sid)
          continue
        }
        const rate = rateOf(bucket, at)
        if (rate != null && rate > 0) output[sid] = roundRate(rate)
      }
      return output
    },

    dispose() {
      sessions.clear()
    },
  }
}
