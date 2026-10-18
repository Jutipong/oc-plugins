/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { buildPanelModel, combineColumns } from "../model.mjs"
import { LineList } from "./kit.tsx"

/**
 * Full dashboard for the `session.panel` slot. The host owns sizing/focus;
 * the panel renders one column when narrow and two columns at width >= 100.
 * Keyboard layers created here are scoped to the panel by the host.
 */
export function StatusPanel(props) {
  const [snapshot, setSnapshot] = createSignal(null)
  const [cores, setCores] = createSignal(props.context.options?.cores === "all" ? "all" : "p")

  onMount(() => {
    const unsubscribe = props.collector.subscribe(setSnapshot)
    onCleanup(unsubscribe)
  })

  props.context.keymap.layer(() => ({
    commands: [
      {
        id: "sys-status.fullscreen",
        title: "Toggle fullscreen",
        bind: "f",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "sys-status.cores",
        title: "Cycle CPU cores",
        bind: "c",
        run: () => setCores((value) => (value === "all" ? "p" : "all")),
      },
      {
        id: "sys-status.restart",
        title: "Restart collector",
        bind: "r",
        run: () => {
          props.collector.restart()
          props.context.ui.toast.show({ message: "System collector restarted", variant: "info", duration: 2000 })
        },
      },
      {
        id: "sys-status.close",
        title: "Close panel",
        bind: "q",
        run: () => props.panel.close(),
      },
    ],
  }))

  const model = createMemo(() => buildPanelModel(snapshot(), { width: props.panel.width, cores: cores(), barStyle: props.barStyle }))
  const blank = [{ text: " ", tone: "base" }]
  const rows = createMemo(() => {
    const value = model()
    if (!value.twoColumn) return [...value.left, blank, ...value.right, blank, ...value.full]
    return [...combineColumns(value.left, value.right, value.columnWidth), blank, ...value.full]
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} gap={0}>
      <LineList lines={model().header} theme={props.context.theme} colorMode={props.colorMode} />
      <LineList lines={rows()} theme={props.context.theme} colorMode={props.colorMode} />
      <LineList lines={model().footer} theme={props.context.theme} colorMode={props.colorMode} />
    </box>
  )
}
