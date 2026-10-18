/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { buildSidebarModel } from "../model.mjs"
import { LineList } from "./kit.tsx"

const SIDEBAR_WIDTH = 36

/**
 * Compact or full status block for `sidebar.content`. Subscribes to the
 * shared collector on mount; the collector stops itself a few seconds after
 * the sidebar unmounts.
 */
export function SidebarStatus(props) {
  const [snapshot, setSnapshot] = createSignal(null)

  onMount(() => {
    const unsubscribe = props.collector.subscribe(setSnapshot)
    onCleanup(unsubscribe)
  })

  const model = createMemo(() =>
    buildSidebarModel(snapshot(), {
      width: SIDEBAR_WIDTH,
      mode: props.mode,
      spacing: props.spacing,
      rowSpacing: props.rowSpacing,
      cores: props.cores,
      barStyle: props.barStyle,
      frame: props.frame,
    }),
  )

  return (
    <box flexDirection="column">
      <LineList lines={model().lines} theme={props.context.theme} colorMode={props.colorMode} />
    </box>
  )
}
