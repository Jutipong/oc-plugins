# budy

Playful desk buddy for OpenCode: mirrors CLI activity onto the ESP32-S3 RLCD
avatar (board repo: [ESP32-S3-AI](https://github.com/Jutipong/ESP32-S3-AI))
as `{"event":"..."}` lines over USB CDC. Ported from the "avatar" plugin v6 —
same state machine, renamed id/files/env vars.

- `working` while a tool runs · `thinking` while the turn/stream is live ·
  `speaking` while the answer text streams (600 ms throttle)
- pulses: `listening` (your prompt), `happy` (tool turn succeeded),
  `excited` (tool ≥8s), `confused` (failure/retry), `greeting` (wake up)
- `idle` the moment a turn ends; while idle it **plays by itself every 8-12s**
  (`wag`/`curious`/`happy`/`excited` by mood) and naps (`sleeping`) after
  15 quiet minutes. Energy + streak drive the mood; real states always win
  over play pulses.

## Requirements

- OpenCode V2, Windows host
- `serialport` for the fast sender (node, ~200 ms); without it the plugin
  falls back to PowerShell (~340 ms)
- Board side: the 14 poses must exist in the board firmware + SD:
  `idle listening thinking speaking happy excited success confused error
  sleeping working greeting wag curious` (see the board repo)

## Install

Recommended — load in place (this repo stays the source of truth):

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///D:/code/oc-plugins/plugins/budy"]
}
```

```powershell
cd D:\code\oc-plugins\plugins\budy
bun install        # serialport for the fast sender
```

then restart OpenCode.

Fallback — copy mode (from the repo root):

```powershell
.\install.ps1 -Plugin budy
```

copies `budy.js` + `budy-send.*` into `%USERPROFILE%\.config\opencode\plugins\`
(make sure `bun add serialport` has been run in `~/.config/opencode`).

Upgrading from the old `avatar` plugin: delete
`~/.config/opencode/plugins/avatar.js` + `avatar-send.*` afterwards — running
both plugins doubles every event.

## Env vars

| var | default | meaning |
|---|---|---|
| `BUDY_COM` (or `AVATAR_COM`) | `COM5` | serial port of the board |
| `BUDY_DEBUG=1` (or `AVATAR_DEBUG=1`) | off | write `~/.config/opencode/plugins/budy-debug.log` (512 KB rotate) |
| `BUDY_SEND_MJS` / `BUDY_SEND_PS1` | next to `index.js`, else the live plugins dir | override sender paths |
| `BUDY_PLUGIN_SRC` | `../index.js` | harness-only: plugin under test |

## Test (offline)

```powershell
cd plugins\budy
bun run test        # or: node test/harness.mjs
```

Mocks `@opencode/plugin` + `node:child_process`, runs a 100x virtual clock and
holds the play timers; ~51 assertions over turn end, child sessions, stream
stalls, play pulses, nap/wake. Must print `ALL TESTS PASSED`.

## Notes

- Several OpenCode hosts can run at once; all share one COM port — every send
  retries (node → powershell, backoff) and heartbeats add jitter.
- The heartbeat resends the current state every 30 s (+jitter) but only after
  real activity (it never yanks the board's clock screen when idle).
- Wire protocol: newline-delimited JSON `{"event":"<pose>"}`; one writer at a
  time; the board acks only while its avatar screen is shown.
