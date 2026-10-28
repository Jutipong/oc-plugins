// system-status — option/env resolution (pure).

import { clampNumber } from "./format.mjs"

export const DEFAULT_INTERVAL_SEC = 2
export const MIN_INTERVAL_SEC = 1
export const MAX_INTERVAL_SEC = 10
export const COLOR_MODES = ["mole", "theme"]

export function truthyFlag(value) {
  return value === true || value === "1" || value === "true" || value === "yes"
}

function falsyFlag(value) {
  return value === false || value === 0 || value === "0" || value === "false" || value === "no" || value === "off"
}

/**
 * Merge cli.json `options` with SYSTEM_STATUS_* environment variables.
 * Options win.
 */
export function resolveOptions({ options = {}, env = {} } = {}) {
  return {
    intervalSeconds: clampNumber(
      options.interval ?? env.SYSTEM_STATUS_INTERVAL,
      DEFAULT_INTERVAL_SEC,
      MIN_INTERVAL_SEC,
      MAX_INTERVAL_SEC,
    ),
    colorMode: COLOR_MODES.includes(options.colorMode)
      ? options.colorMode
      : COLOR_MODES.includes(env.SYSTEM_STATUS_COLOR_MODE)
        ? env.SYSTEM_STATUS_COLOR_MODE
        : "mole",
    network: !falsyFlag(options.network ?? env.SYSTEM_STATUS_NETWORK),
    debug: options.debug === true || truthyFlag(env.SYSTEM_STATUS_DEBUG),
  }
}
