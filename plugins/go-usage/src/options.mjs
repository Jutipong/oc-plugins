// go-usage — option/env resolution (pure).

import { DEFAULT_BASE_URL, normalizeBaseUrl } from "./auth.mjs"

export const DEFAULT_INTERVAL_SEC = 300
export const MIN_INTERVAL_SEC = 15
export const MAX_INTERVAL_SEC = 3600
export const FRAME_STYLES = ["rounded", "heavy", "none"]
export const BAR_STYLES = ["mole", "solid"]
export const COLOR_MODES = ["mole", "theme"]

export function clampInterval(seconds, fallback = DEFAULT_INTERVAL_SEC) {
  const value = Number(seconds)
  const base = Number.isFinite(value) && value > 0 ? value : fallback
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.round(base)))
}

export function truthyFlag(value) {
  return value === true || value === "1" || value === "true" || value === "yes"
}

/**
 * Merge cli.json `options` with GO_USAGE_* environment variables. Options win.
 */
export function resolveOptions({ options = {}, env = {} } = {}) {
  return {
    intervalSeconds: clampInterval(options.interval ?? env.GO_USAGE_INTERVAL),
    baseUrl: normalizeBaseUrl(options.baseUrl ?? env.GO_USAGE_BASE_URL ?? DEFAULT_BASE_URL),
    orgId: options.org ?? env.GO_USAGE_ORG ?? null,
    sidebar: options.sidebar !== false,
    placement: options.placement === "bottom" ? "bottom" : "top",
    frame: FRAME_STYLES.includes(options.frame)
      ? options.frame
      : FRAME_STYLES.includes(env.GO_USAGE_FRAME)
        ? env.GO_USAGE_FRAME
        : "rounded",
    barStyle: BAR_STYLES.includes(options.barStyle)
      ? options.barStyle
      : BAR_STYLES.includes(env.GO_USAGE_BAR_STYLE)
        ? env.GO_USAGE_BAR_STYLE
        : "mole",
    colorMode: COLOR_MODES.includes(options.colorMode)
      ? options.colorMode
      : COLOR_MODES.includes(env.GO_USAGE_COLOR_MODE)
        ? env.GO_USAGE_COLOR_MODE
        : "mole",
    openBrowser: options.openBrowser !== false && !truthyFlag(env.GO_USAGE_NO_OPEN),
    debug: options.debug === true || truthyFlag(env.GO_USAGE_DEBUG),
  }
}
