/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createCollector } from "./collector.mjs"
import { createLogger } from "./log.mjs"
import { resolveOptions } from "./options.mjs"
import { PromptUsage } from "./ui/line.tsx"

export default Plugin.define({
  id: "system-status",
  setup(context) {
    const env = globalThis.process?.env ?? {}
    const options = resolveOptions({ options: context.options ?? {}, env })
    const log = createLogger(options.debug)

    log.write(`setup interval=${options.intervalSeconds}s`)

    const collector = createCollector({
      intervalMs: options.intervalSeconds * 1000,
      logger: log,
    })

    const dispose = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <PromptUsage context={context} controller={collector} colorMode={options.colorMode} />,
    })

    return () => {
      try {
        dispose?.()
      } catch {
        // Slot disposal must never block plugin unload.
      }
      collector.dispose()
    }
  },
})
