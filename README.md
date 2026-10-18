# oc-plugins — OpenCode plugins

A monorepo for my [OpenCode](https://opencode.ai) V2 plugins. Each plugin is
self-contained in its own folder under `plugins/`: plugin code, PC-side
senders, an offline test harness, and its own README.

| plugin | what it does | hardware |
|---|---|---|
| [esp-buddy](plugins/esp-buddy) | playful desk buddy: mirrors OpenCode activity onto an ESP32-S3 RLCD avatar (`working`/`thinking`/`speaking`/`happy`/`confused` + idle play pulses) | [ESP32-S3-AI](https://github.com/Jutipong/ESP32-S3-AI) |

## Install

Recommended — load the folder in place (the repo stays the source of truth;
edit and restart OpenCode):

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///D:/code/oc-plugins/plugins/esp-buddy"]
}
```

```powershell
cd D:\code\oc-plugins\plugins\esp-buddy
bun install          # serialport for the fast sender (powershell fallback needs nothing)
```

Fallback — copy into the live config folder:

```powershell
.\install.ps1 -Plugin esp-buddy     # also: -List
```

Each plugin's README documents requirements, env vars, and behavior.

## Adding a plugin

1. `plugins/<name>/` with `index.js` (`Plugin.define({ id: "<name>", ... })`),
   `package.json` (private, `main: "index.js"`), `README.md`, and
   `test/harness.mjs` (+ `mock-loader.mjs`).
2. Conventions: helper files `<name>-send.*`, debug log
   `<name>-debug.log` under `~/.config/opencode/plugins/`, env vars
   `<NAME>_*`.
3. `bun run test` inside the plugin folder must print `ALL TESTS PASSED`.
4. Read `AGENTS.md` first — it has the verified OpenCode V2 API facts and the
   rules (including: never commit/push without an explicit order).

## Layout

```
plugins/
  esp-buddy/
    index.js          # the plugin (Plugin.define id "esp-buddy")
    esp-buddy-send.mjs  # fast sender (node + serialport, ~200ms)
    esp-buddy-send.ps1  # fallback sender (powershell, ~340ms)
    test/harness.mjs  # offline state-machine test (~51 assertions)
install.ps1           # copy-mode installer for ~/.config/opencode/plugins
```
