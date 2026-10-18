// go-usage — best-effort browser opener for the device-login URL.

import { spawn } from "node:child_process"

export function openCommand(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]]
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]]
  return ["xdg-open", [url]]
}

export function openBrowser(url, enabled = true, log) {
  if (!enabled || typeof url !== "string" || !url) return false
  try {
    const [command, args] = openCommand(url)
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
    return true
  } catch (error) {
    log?.write?.(`open browser failed: ${error?.message ?? error}`)
    return false
  }
}
