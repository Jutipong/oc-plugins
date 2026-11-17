// turn-stats — option/env resolution (pure).

import { clampCharsPerToken } from "./tps.mjs"

export const COLOR_MODES = ["mole", "theme"]

export function truthyFlag(value) {
  return value === true || value === "1" || value === "true" || value === "yes"
}

/**
 * Merge cli.json `options` with TURN_STATS_* environment variables.
 * Options win.
 */
export function resolveOptions({ options = {}, env = {} } = {}) {
  return {
    colorMode: COLOR_MODES.includes(options.colorMode)
      ? options.colorMode
      : COLOR_MODES.includes(env.TURN_STATS_COLOR_MODE)
        ? env.TURN_STATS_COLOR_MODE
        : "mole",
    charsPerToken: clampCharsPerToken(options.tpsFactor ?? env.TURN_STATS_TPS_FACTOR),
    debug: options.debug === true || truthyFlag(env.TURN_STATS_DEBUG),
  }
}
