// go-usage — cache-hit accounting (pure).
//
// The runtime exposes token counters only when a step ends
// (`session.step.ended`), never mid-stream. Those counters are deltas:
// `tokens.input` is what the provider had to read fresh, `tokens.cache.read`
// what came from the prompt cache (and `.write` what was stored). The tracker
// sums them per session, so the footer can show how much of the whole session
// was served from cache:
//
//   hit% = read / (read + input)
//
// `write` is kept for inspection but stays out of the denominator: a write is
// a miss that was stored, not a hit.

export const MAX_TRACKED_SESSIONS = 32

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/** Normalize a runtime `tokens` payload to plain non-negative numbers. */
export function readTokens(tokens) {
  return {
    input: count(tokens?.input),
    output: count(tokens?.output),
    read: count(tokens?.cache?.read),
    write: count(tokens?.cache?.write),
  }
}

/**
 * Integer cache-hit percent, or null when the provider reported no tokens.
 * Rounded down so an incomplete cache never reads as 100%; a step with no
 * fresh input at all is a full hit.
 */
export function cacheHitPercent(tokens) {
  const { input, read } = readTokens(tokens)
  const total = read + input
  if (total <= 0) return null
  if (input === 0) return 100
  return Math.min(99, Math.floor((read / total) * 100))
}

/**
 * Per-session accumulation of step counters.
 *
 * add(sid, tokens, messageID?) — one `session.step.ended` payload for that
 *   session. The optional assistant message ID dedupes a re-delivered step
 *   (durable event replay) so a counter is never added twice.
 * snapshot()       — `{ [sessionID]: { percent, input, read, write, output } }`
 *                    for every tracked session (kept across turns; the map is
 *                    bounded and evicts the least recently used session).
 * clear(sid)       — forget one session.
 */
export function createCacheTracker({ maxSessions = MAX_TRACKED_SESSIONS, maxSeen = 512 } = {}) {
  const sessions = new Map()
  const seen = new Set()

  return {
    add(sid, tokens, messageID) {
      if (!sid || !tokens) return
      if (messageID) {
        const key = `${sid}:${messageID}`
        if (seen.has(key)) return
        seen.add(key)
        while (seen.size > maxSeen) seen.delete(seen.values().next().value)
      }
      const delta = readTokens(tokens)
      if (delta.input + delta.output + delta.read + delta.write === 0) return
      const bucket = sessions.get(sid) ?? { input: 0, output: 0, read: 0, write: 0 }
      bucket.input += delta.input
      bucket.output += delta.output
      bucket.read += delta.read
      bucket.write += delta.write
      // Re-insert so the Map order stays "least recently used first".
      sessions.delete(sid)
      sessions.set(sid, bucket)
      while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
    },

    snapshot() {
      const output = {}
      for (const [sid, bucket] of sessions) {
        output[sid] = {
          percent: cacheHitPercent({ input: bucket.input, cache: { read: bucket.read } }),
          input: bucket.input,
          read: bucket.read,
          write: bucket.write,
          output: bucket.output,
        }
      }
      return output
    },

    clear(sid) {
      if (sid) sessions.delete(sid)
    },

    dispose() {
      sessions.clear()
      seen.clear()
    },
  }
}
