// go-usage — runtime event feed for the live speed and cache meters.
//
// `context.data.listen` delivers the TUI server events; this module maps them
// onto the two pure trackers (see tps.mjs / cache.mjs) and publishes a
// snapshot only when the rendered value changes. The listener and the
// publishers are injected, so the harness drives it with synthetic events
// and no OpenTUI.

import { createCacheTracker } from "./cache.mjs"
import { createSpeedTracker } from "./tps.mjs"

/** How often the speed snapshot is recomputed (the runtime batches deltas). */
export const SPEED_TICK_MS = 500

export function createUsageFeed({
  directory,
  tps = true,
  cache = true,
  charsPerToken,
  log,
  onSpeed,
  onCache,
} = {}) {
  const speedTracker = tps ? createSpeedTracker({ charsPerToken }) : null
  const cacheTracker = cache ? createCacheTracker() : null
  // An empty snapshot matches the entry's initial observable state, so it is
  // never published and an idle tick stays free.
  let speedSignature = "{}"
  let cacheSignature = "{}"

  function publishSpeed() {
    if (!speedTracker) return
    const next = speedTracker.snapshot()
    const signature = JSON.stringify(next)
    if (signature === speedSignature) return
    speedSignature = signature
    onSpeed?.(next)
  }

  function publishCache() {
    if (!cacheTracker) return
    const next = cacheTracker.snapshot()
    const signature = JSON.stringify(next)
    if (signature === cacheSignature) return
    cacheSignature = signature
    onCache?.(next)
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
        case "session.step.started":
          speedTracker?.start(sid)
          break
        case "session.text.delta":
        case "session.reasoning.delta": {
          const delta = data.delta
          if (typeof delta === "string" && delta) speedTracker?.push(sid, delta.length)
          break
        }
        case "session.step.ended":
          cacheTracker?.add(sid, data.tokens, data.assistantMessageID)
          publishCache()
          return
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
        case "session.idle":
          speedTracker?.end(sid)
          break
        default:
          return
      }
      publishSpeed()
    } catch (error) {
      log?.write?.(`usage event failed: ${error?.message ?? error}`)
    }
  }

  function dispose() {
    speedTracker?.dispose()
    cacheTracker?.dispose()
  }

  return { onEvent, tick: publishSpeed, dispose }
}
