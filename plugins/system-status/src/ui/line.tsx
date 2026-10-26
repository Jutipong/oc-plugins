/** @jsxImportSource @opentui/solid */
import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { RGBA } from "@opentui/core"
import { MOLE_PALETTE } from "../colors.mjs"
import { buildPromptLine } from "../model.mjs"

const MOLE_RGBA = Object.fromEntries(
  Object.entries(MOLE_PALETTE).map(([tone, rgb]) => [tone, RGBA.fromInts(rgb[0], rgb[1], rgb[2], 255)]),
)

/** Map a semantic model tone to a resolved theme token, or Mole's fixed palette. */
function toneColor(theme, tone, colorMode = "mole") {
  if (tone === "onKeyboard") return MOLE_RGBA.onKeyboard
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
    case "success":
      return theme.text.feedback.success.base
    case "warning":
      return theme.text.feedback.warning.base
    case "danger":
    case "error":
      return theme.text.feedback.error.base
    default:
      return theme.text.base
  }
}

/**
 * Segment background. The badge keeps Mole's pink in both color modes: themes
 * do not guarantee a pink hue token, and a missing one would render an
 * invisible box.
 */
function bgColor(bg) {
  return bg === "keyboard" ? MOLE_RGBA.keyboard : undefined
}

/** Single-line renderer for the session status row, right-aligned (no frame, no bars). */
export function LineText(props) {
  return (
    <text fg={props.theme?.text?.base} width="100%" textAlign="right">
      <For each={props.line}>
        {(segment) => (
          <span
            style={{
              fg: toneColor(props.theme, segment.tone, props.colorMode),
              bg: bgColor(segment.bg),
            }}
          >
            {segment.text}
          </span>
        )}
      </For>
    </text>
  )
}

/**
 * `session.composer.top` contribution, aligned to the right edge of the row.
 *
 * Subscribes to the reference-counted collector: sampling starts when the row
 * mounts and stops shortly after the session closes.
 */
export function PromptUsage(props) {
  const [view, setView] = createSignal(props.controller.get())

  onMount(() => {
    const unsubscribe = props.controller.subscribe(setView)
    onCleanup(unsubscribe)
  })

  const line = createMemo(() => buildPromptLine(view(), { width: props.width ?? 46 }))

  return <LineText line={line()} theme={props.context.theme} colorMode={props.colorMode} />
}
