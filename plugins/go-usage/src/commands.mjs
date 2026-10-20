// go-usage — command routing (pure, testable).
//
// `/go-usage` with no argument is a smart command: it starts the login
// flow when the plugin is not connected and shows the details dialog otherwise.

export function resolveCommand(input, phase) {
  const command = String(input ?? "").trim().split(/\s+/)[0].toLowerCase()
  if (command === "") {
    return phase === "checking" || phase === "disconnected" ? "login" : "details"
  }
  if (command === "login" || command === "connect") return "login"
  if (command === "logout" || command === "disconnect") return "logout"
  if (command === "refresh") return "refresh"
  return "unknown"
}
