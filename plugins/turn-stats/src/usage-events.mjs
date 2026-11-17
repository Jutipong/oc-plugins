// turn-stats — runtime event feed for the live meters and the turn timer.
//
// `context.data.listen` delivers the TUI server events; this module maps them
// onto the pure trackers (see tps.mjs / cache.mjs / timer.mjs) and publishes a
// snapshot only when the rendered value changes. The listener and the
// publishers are injected, so the harness drives it with synthetic events and
// no OpenTUI.

import { createCacheTracker } from "./cache.mjs"
import { createSpeedTracker } from "./tps.mjs"
import { createTurnTimer } from "./timer.mjs"

/** How often the live snapshots are recomputed (the runtime batches deltas). */
export const SPEED_TICK_MS = 500

/**
 * The visible turn value changes once per second (and when a turn ends), so
 * the signature ignores sub-second jitter: an idle tick stays free and a live
 * timer redraws at most once a second.
 */
function turnSignatureOf(snapshot) {
  const signature = {}
  for (const [sid, entry] of Object.entries(snapshot)) {
    signature[sid] = `${entry.running ? "r" : "f"}${Math.floor(entry.ms / 1000)}`
  }
  return JSON.stringify(signature)
}

export function createUsageFeed({ directory, charsPerToken, now = Date.now, log, onSpeed, onCache, onTurn } = {}) {
  const speedTracker = createSpeedTracker({ charsPerToken })
  const cacheTracker = createCacheTracker()
  const timer = createTurnTimer()
  // An empty snapshot matches the entry's initial observable state, so it is
  // never published and an idle tick stays free.
  let speedSignature = "{}"
  let cacheSignature = "{}"
  let turnSignature = "{}"

  function publishSpeed() {
    const next = speedTracker.snapshot()
    const signature = JSON.stringify(next)
    if (signature === speedSignature) return
    speedSignature = signature
    onSpeed?.(next)
  }

  function publishCache() {
    const next = cacheTracker.snapshot()
    const signature = JSON.stringify(next)
    if (signature === cacheSignature) return
    cacheSignature = signature
    onCache?.(next)
  }

  function publishTurn() {
    const next = timer.snapshot(now())
    const signature = turnSignatureOf(next)
    if (signature === turnSignature) return
    turnSignature = signature
    onTurn?.(next)
  }

  /** One runtime event -> tracker calls + a throttled publish. */
  function onEvent(event) {
    try {
      const details = event?.details ?? event
      const type = details?.type
      const data = details?.data ?? {}
      const dir = details?.location?.directory
      if (dir && directory && dir !== directory) return
      const sid = data.sessionID
      if (!sid) return
      switch (type) {
        case "session.execution.started":
          speedTracker.start(sid)
          timer.start(sid, now())
          break
        case "session.step.started":
          // A step inside a running turn restarts the speed window only; the
          // turn clock keeps counting from execution.started.
          speedTracker.start(sid)
          break
        case "session.text.delta":
        case "session.reasoning.delta": {
          const delta = data.delta
          if (typeof delta === "string" && delta) speedTracker.push(sid, delta.length)
          break
        }
        case "session.step.ended":
          cacheTracker.add(sid, data.tokens, data.assistantMessageID)
          publishCache()
          return
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
        case "session.idle":
          speedTracker.end(sid)
          timer.end(sid, now())
          break
        default:
          return
      }
      publishSpeed()
      publishTurn()
    } catch (error) {
      log?.write?.(`usage event failed: ${error?.message ?? error}`)
    }
  }

  function tick() {
    publishSpeed()
    publishTurn()
  }

  function dispose() {
    speedTracker.dispose()
    cacheTracker.dispose()
    timer.dispose()
  }

  return { onEvent, tick, dispose }
}
