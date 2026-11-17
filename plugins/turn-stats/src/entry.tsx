/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createLogger } from "./log.mjs"
import { resolveOptions } from "./options.mjs"
import { createObservable } from "./store.mjs"
import { SPEED_TICK_MS, createUsageFeed } from "./usage-events.mjs"
import { PromptTurnStats } from "./ui/line.tsx"

export default Plugin.define({
  id: "turn-stats",
  setup(context) {
    const env = globalThis.process?.env ?? {}
    const options = resolveOptions({ options: context.options ?? {}, env })
    const log = createLogger(options.debug)

    log.write(`setup colorMode=${options.colorMode} tpsFactor=${options.charsPerToken}`)

    // `{ [sessionID]: tokensPerSecond }` for sessions that are streaming now.
    const speeds = createObservable({})
    // `{ [sessionID]: { percent, input, read, write, output } }` per session.
    const caches = createObservable({})
    // `{ [sessionID]: { running, ms } }` turn clock per session.
    const turns = createObservable({})

    const disposers = []

    // Live output speed, cache hit and turn clock: the runtime streams
    // text/reasoning deltas but no token counters until a step ends (see
    // usage-events.mjs).
    if (typeof context.data?.listen === "function") {
      const feed = createUsageFeed({
        directory: context.location?.directory,
        charsPerToken: options.charsPerToken,
        log,
        onSpeed: (next) => speeds.set(next),
        onCache: (next) => caches.set(next),
        onTurn: (next) => turns.set(next),
      })
      try {
        disposers.push(context.data.listen(feed.onEvent))
      } catch (error) {
        log.write(`usage listen failed: ${error?.message ?? error}`)
      }
      const speedTimer = setInterval(feed.tick, SPEED_TICK_MS)
      disposers.push(() => {
        clearInterval(speedTimer)
        feed.dispose()
      })
    }

    disposers.push(
      context.ui.slot({
        append: "session.composer.top",
        render: (slot) => (
          <PromptTurnStats
            context={context}
            speeds={speeds}
            caches={caches}
            turns={turns}
            sessionID={slot?.sessionID}
            colorMode={options.colorMode}
          />
        ),
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Disposal must never block plugin unload.
        }
      }
    }
  },
})
