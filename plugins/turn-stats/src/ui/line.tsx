/** @jsxImportSource @opentui/solid */
import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { RGBA } from "@opentui/core"
import { MOLE_PALETTE } from "../colors.mjs"
import { buildPromptLine, cacheForSession, speedForSession, turnForSession } from "../model.mjs"

const MOLE_RGBA = Object.fromEntries(
  Object.entries(MOLE_PALETTE).map(([tone, rgb]) => [tone, RGBA.fromInts(rgb[0], rgb[1], rgb[2], 255)]),
)

/** Map a semantic model tone to a resolved theme token, or Mole's fixed palette. */
function toneColor(theme, tone, colorMode = "mole") {
  if (tone === "hot") return MOLE_RGBA.deepGreen // fixed in both color modes
  if (tone === "pink") return MOLE_RGBA.draculaPink // fixed in both color modes
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

/** Single-line renderer for the row above the prompt (no frame, no bars). */
export function LineText(props) {
  return (
    <text fg={props.theme?.text?.base} wrapMode="none">
      <For each={props.line}>
        {(segment) => <span style={{ fg: toneColor(props.theme, segment.tone, props.colorMode) }}>{segment.text}</span>}
      </For>
    </text>
  )
}

/**
 * `session.composer.top` contribution: one line, right-aligned above the
 * input prompt.
 *
 * The slot passes only `sessionID` (no width). The host stacks slot content in
 * a full-width column, so the row box stretches across the composer and
 * `justifyContent` pins the line to the right edge; a narrow terminal clips
 * the line from the model's width cap instead of shifting it.
 *
 * Follows the shared observables owned by the entry; the line itself is built
 * by the pure model so every state stays testable without OpenTUI.
 */
export function PromptTurnStats(props) {
  const [speeds, setSpeeds] = createSignal(props.speeds.get())
  const [caches, setCaches] = createSignal(props.caches.get())
  const [turns, setTurns] = createSignal(props.turns.get())

  onMount(() => {
    const unsubscribeSpeeds = props.speeds.subscribe(setSpeeds)
    const unsubscribeCaches = props.caches.subscribe(setCaches)
    const unsubscribeTurns = props.turns.subscribe(setTurns)
    onCleanup(() => {
      unsubscribeSpeeds()
      unsubscribeCaches()
      unsubscribeTurns()
    })
  })

  const line = createMemo(() =>
    buildPromptLine({
      speed: speedForSession(speeds(), props.sessionID),
      cache: cacheForSession(caches(), props.sessionID),
      turn: turnForSession(turns(), props.sessionID),
    }),
  )

  return (
    <box flexDirection="row" justifyContent="flex-end">
      <LineText line={line()} theme={props.context.theme} colorMode={props.colorMode} />
    </box>
  )
}
