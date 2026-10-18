/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { clampInterval, createCollector } from "./collector/index.mjs"
import { SidebarStatus } from "./ui/sidebar.tsx"
import { StatusPanel } from "./ui/panel.tsx"

const PANEL_NAME = "sys-status.panel"

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

    // Debug helper for smoke tests: open the panel automatically once a
    // session is available. Never active unless explicitly requested.
    let autoPanelTimer = null
    if (process.env.SYS_STATUS_AUTO_PANEL === "1") {
      autoPanelTimer = setInterval(() => {
        if (context.ui.panel.open(PANEL_NAME)) {
          clearInterval(autoPanelTimer)
          autoPanelTimer = null
        }
      }, 1000)
      setTimeout(() => {
        if (autoPanelTimer) {
          clearInterval(autoPanelTimer)
          autoPanelTimer = null
        }
      }, 15_000)
    }

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

    disposers.push(
      context.ui.slot({
        append: "session.panel",
        render: (panel) => (
          <Show when={panel.name === PANEL_NAME}>
            <StatusPanel context={context} collector={collector} panel={panel} barStyle={barStyle} colorMode={colorMode} />
          </Show>
        ),
      }),
    )

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "sys-status.open",
          title: "System status",
          description: "Open the system dashboard panel",
          group: "System",
          palette: true,
          slash: { name: "sys", aliases: ["system"] },
          run: () => {
            const opened = context.ui.panel.open(PANEL_NAME)
            if (!opened) context.ui.toast.show({ message: "Open a session first", variant: "info", duration: 2500 })
          },
        },
      ],
    }))

    return () => {
      if (autoPanelTimer) {
        clearInterval(autoPanelTimer)
        autoPanelTimer = null
      }
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
