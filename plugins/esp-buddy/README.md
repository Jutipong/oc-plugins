# esp-buddy

Playful desk buddy for OpenCode: mirrors CLI activity onto the ESP32-S3 RLCD
buddy screen (board repo: [ESP32-S3-AI](https://github.com/Jutipong/ESP32-S3-AI))
as `{"event":"..."}` lines over USB CDC. Ported from the legacy "avatar" plugin
v6 — same state machine, ESP-specific naming (`esp-buddy`, `ESP_BUDDY_*`).

- `working` while a tool runs · `thinking` while the turn/stream is live ·
  `speaking` while the answer text streams (600 ms throttle)
- pulses: `listening` (your prompt), `happy` (tool turn succeeded),
  `excited` (tool ≥8s), `confused` (failure/retry), `greeting` (wake up)
- `idle` the moment a turn ends; while idle it **plays by itself every 8-12s**
  (`wag`/`curious`/`happy`/`excited` by mood) and naps (`sleeping`) after
  15 quiet minutes. Energy + streak drive the mood; real states always win
  over play pulses.

## Requirements

- OpenCode V2 on macOS or Windows
- `serialport` for the fast sender (node, ~200 ms); on Windows the plugin
  falls back to PowerShell (~340 ms) when it is missing. macOS has no
  PowerShell fallback — the node sender is the only path there
- the board's serial port is auto-detected on macOS (`/dev/cu.usbmodem*`); on
  Windows it defaults to `COM5` (`ESP_BUDDY_COM` overrides both)
- **no board, no cost**: when the resolved port does not exist (unplugged
  board, stale `BUDY_COM`) the plugin does not spawn a sender at all
- Board side: the 14 poses must exist in the board firmware + SD:
  `idle listening thinking speaking happy excited success confused error
  sleeping working greeting wag curious` (see the board repo)

## Install

Recommended — load in place (this repo stays the source of truth):

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///D:/code/oc-plugins/plugins/esp-buddy"] // macOS: file:///Users/you/SourceCode/oc-plugins/plugins/esp-buddy
}
```

```sh
cd plugins/esp-buddy
bun install        # serialport for the fast sender
```

then restart OpenCode.

Fallback — copy mode (from the repo root):

```powershell
.\install.ps1 -Plugin esp-buddy
```

copies `esp-buddy.js` + `esp-buddy-send.*` into `%USERPROFILE%\.config\opencode\plugins\`
(make sure `bun add serialport` has been run in `~/.config/opencode`).

Upgrading: delete the old `budy` and `avatar` live files —
`~/.config/opencode/plugins/budy.js`, `budy-send.*`, `avatar.js`,
`avatar-send.*` — and point the plugin path in `opencode.jsonc` at
`plugins/esp-buddy`. Running two copies doubles every event.

## Env vars

| var | default | meaning |
|---|---|---|
| `ESP_BUDDY_COM` (or legacy `BUDY_COM` / `AVATAR_COM`) | auto-detect `/dev/cu.usbmodem*` (macOS) / `COM5` (Windows) | serial port of the board; a path that does not exist disables sends |
| `ESP_BUDDY_DEBUG=1` (or legacy `BUDY_DEBUG` / `AVATAR_DEBUG`) | off | write `~/.config/opencode/plugins/esp-buddy-debug.log` (512 KB rotate) |
| `ESP_BUDDY_SEND_MJS` / `ESP_BUDDY_SEND_PS1` (or legacy `BUDY_*` / `AVATAR_*`) | next to `index.js`, else the live plugins dir | override sender paths |
| `ESP_BUDDY_PLUGIN_SRC` (or legacy `BUDY_PLUGIN_SRC`) | `../index.js` | harness-only: plugin under test |

## Test (offline)

```powershell
cd plugins\esp-buddy
bun run test        # or: node test/harness.mjs
```

Mocks `@opencode/plugin` + `node:child_process`, runs a 100x virtual clock and
holds the play timers; ~60 assertions over turn end, child sessions, stream
stalls, play pulses, nap/wake, port resolution (macOS auto-detect, stale
override) and the no-device guard. Must print `ALL TESTS PASSED`.

## Notes

- Several OpenCode hosts can run at once; all share one COM port — every send
  retries (node → powershell on Windows, backoff) and heartbeats add jitter.
- The port is re-resolved on every send, so plugging the board in later just
  works and unplugging it stops the sender subprocesses immediately.
- The heartbeat resends the current state every 30 s (+jitter) but only after
  real activity (it never yanks the board's clock screen when idle).
- Wire protocol: newline-delimited JSON `{"event":"<pose>"}`; one writer at a
  time; the board acks only while its buddy screen is shown.
