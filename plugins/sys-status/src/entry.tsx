/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { clampInterval, createCollector } from "./collector/index.mjs"
import { SidebarStatus } from "./ui/sidebar.tsx"

export default Plugin.define({
  id: "sys-status",
  setup(context) {
    const options = context.options ?? {}
    const seconds = Number(options.interval)
    const barStyle = options.barStyle === "solid" ? "solid" : "mole"
    const frame = options.frame === "heavy" || options.frame === "none" ? options.frame : "rounded"
    const colorMode = options.colorMode === "theme" ? "theme" : "mole"
    const sidebarMode = options.sidebarMode === "full" ? "full" : "compact"
    const rowSpacing =
      options.rowSpacing === "compact" || options.rowSpacing === "normal" || options.rowSpacing === "airy"
        ? options.rowSpacing
        : undefined
    const cores = options.cores === "all" ? "all" : "p"
    const collector = createCollector({
      intervalMs: clampInterval(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined),
    })

    const disposers = []

    if (options.sidebar !== false) {
      const claim =
        options.placement === "bottom"
          ? { append: "sidebar.content" }
          : { prepend: "sidebar.content" }
      disposers.push(
        context.ui.slot({
          ...claim,
          render: () => (
            <SidebarStatus
              context={context}
              collector={collector}
              mode={sidebarMode}
              spacing={options.spacing}
              rowSpacing={rowSpacing}
              cores={cores}
              barStyle={barStyle}
              frame={frame}
              colorMode={colorMode}
            />
          ),
        }),
      )
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Disposal must never block plugin unload.
        }
      }
      collector.stop()
    }
  },
})
