// Fast esp-buddy sender (node + serialport, ~20ms vs ~340ms powershell).
// Usage: node esp-buddy-send.mjs <event> [COM5]
import { SerialPort } from "serialport";

const VALID = ["idle", "listening", "thinking", "speaking", "happy", "excited",
  "success", "confused", "error", "sleeping", "working", "greeting",
  "wag", "curious"];
const evt = process.argv[2];
const portPath =
  process.argv[3] || process.env.ESP_BUDDY_COM || process.env.BUDY_COM || process.env.AVATAR_COM || "COM5";
if (!VALID.includes(evt)) {
  console.error("usage: node esp-buddy-send.mjs <event> [port]");
  process.exit(2);
}
try {
  const port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
  await port.open();
  await new Promise((res, rej) => port.write(`{"event":"${evt}"}\n`, (e) => (e ? rej(e) : res())));
  await port.drain();
  await port.close();
} catch (e) {
  console.error(String((e && e.message) || e).slice(0, 160));
  process.exit(1);
}
