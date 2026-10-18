// go-usage — optional debug log (GO_USAGE_DEBUG=1), OFF by default.
// Writes `~/.config/opencode/plugins/go-usage-debug.log` and truncates at
// 512 KB, following the repo convention.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const MAX_LOG_BYTES = 512 * 1024

export function logPath(env = {}, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config")
  return path.join(base, "opencode", "plugins", "go-usage-debug.log")
}

export function createLogger(enabled = false, { file = logPath(process.env ?? {}), maxBytes = MAX_LOG_BYTES } = {}) {
  if (!enabled) {
    return {
      enabled: false,
      path: file,
      write() {},
    }
  }
  return {
    enabled: true,
    path: file,
    write(message) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        try {
          const stats = fs.statSync(file)
          if (stats.size > maxBytes) fs.writeFileSync(file, "")
        } catch {
          // Missing log file: nothing to rotate.
        }
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(message)}\n`)
      } catch {
        // Logging must never break the plugin.
      }
    },
  }
}
