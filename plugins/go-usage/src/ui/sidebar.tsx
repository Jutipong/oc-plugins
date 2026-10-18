/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { buildSidebarModel } from "../model.mjs"
import { LineList } from "./kit.tsx"

// The sidebar is 42 columns wide; 36 usable after paddings (matches sys-status).
const SIDEBAR_WIDTH = 36

/**
 * Compact OpenCode Go usage block for `sidebar.content`.
 *
 * The frame (title + clock) is drawn by the model so the text is fully
 * testable; this component only renders the lines and follows the shared
 * observable owned by the entry.
 */
export function SidebarUsage(props) {
  const [view, setView] = createSignal(props.state.get())

  onMount(() => {
    const unsubscribe = props.state.subscribe(setView)
    onCleanup(unsubscribe)
  })

  const model = createMemo(() =>
    buildSidebarModel(view(), {
      width: SIDEBAR_WIDTH,
      frame: props.frame ?? "rounded",
      barStyle: props.barStyle ?? "mole",
    }),
  )

  return (
    <box flexDirection="column">
      <LineList lines={model().lines} theme={props.context.theme} colorMode={props.colorMode} />
    </box>
  )
}
