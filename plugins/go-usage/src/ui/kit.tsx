/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js"
import { RGBA } from "@opentui/core"
import { MOLE_PALETTE } from "../colors.mjs"

const MOLE_RGBA = Object.fromEntries(
  Object.entries(MOLE_PALETTE).map(([tone, rgb]) => [tone, RGBA.fromInts(rgb[0], rgb[1], rgb[2], 255)]),
)

/** Map a semantic model tone to a resolved theme token, or Mole's fixed palette. */
export function toneColor(theme, tone, colorMode = "theme") {
  if (colorMode === "mole") {
    if (tone === "faint" || tone === "muted") return MOLE_RGBA.muted
    if (tone === "border") return MOLE_RGBA.border
    if (tone === "accent") return MOLE_RGBA.accent
    if (tone === "danger" || tone === "error") return MOLE_RGBA.error
    if (tone === "success" || tone === "warning") return MOLE_RGBA[tone]
    return theme?.text?.base
  }
  if (!theme) return undefined
  switch (tone) {
    case "muted":
      return theme.text.muted
    case "faint":
      return theme.text.faint ?? theme.text.muted
    case "border":
      return theme.border?.base ?? theme.text.faint ?? theme.text.muted
    case "success":
      return theme.text.feedback.success.base
    case "warning":
      return theme.text.feedback.warning.base
    case "danger":
    case "error":
      return theme.text.feedback.error.base
    case "accent":
      return theme.text.feedback.info.base
    case "base":
    default:
      return theme.text.base
  }
}

function SegmentText(props) {
  const segment = props.segment
  const style = () => ({ fg: toneColor(props.theme, segment.tone, props.colorMode) })
  return (
    <Show when={segment.bold} fallback={<span style={style()}>{segment.text}</span>}>
      <b>
        <span style={style()}>{segment.text}</span>
      </b>
    </Show>
  )
}

export function LineText(props) {
  return (
    <text fg={props.theme?.text?.base}>
      <For each={props.line}>{(segment) => <SegmentText segment={segment} theme={props.theme} colorMode={props.colorMode} />}</For>
    </text>
  )
}

export function LineList(props) {
  return (
    <box flexDirection="column">
      <For each={props.lines}>{(line) => <LineText line={line} theme={props.theme} colorMode={props.colorMode} />}</For>
    </box>
  )
}
