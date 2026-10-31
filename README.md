# oc-plugins — OpenCode plugins

A monorepo for my [OpenCode](https://opencode.ai) V2 plugins. Each plugin is
self-contained in its own folder under `plugins/`: plugin code, senders,
an offline test harness, and its own README.

| plugin | what it does | hardware |
|---|---|---|
| [esp-buddy](plugins/esp-buddy) | playful desk buddy: mirrors OpenCode activity onto an ESP32-S3 RLCD avatar (`working`/`thinking`/`speaking`/`happy`/`confused` + idle play pulses) | [ESP32-S3-AI](https://github.com/Jutipong/ESP32-S3-AI) |
| [go-usage](plugins/go-usage) | OpenCode Go plan usage as a one-line `[H:92% · W:45% · M:44%]` meter plus a live color-coded `⚡120 tok/s` speed field in the prompt footer, device-code login, `/go-usage` command | — |
| [system-status](plugins/system-status) | one-line `[CPU:37% · RAM:62% · NET:↓1.20M ↑240K]` prompt-footer meter (CPU load, RAM, network, macOS + Windows) | any Mac or PC running OpenCode V2 |

## Install

### CLI plugins (go-usage, system-status)

CLI-only plugins are registered in `~/.config/opencode/cli.json` (Windows:
`%USERPROFILE%\.config\opencode\cli.json`) — never in `opencode.json(c)`:

```sh
cd plugins/go-usage
node scripts/install.mjs          # then run /go-usage login inside OpenCode

cd plugins/system-status
node scripts/install.mjs          # CPU/RAM footer line
```

Then restart OpenCode and open a session: `/go-usage` renders the Go plan
meters in the prompt footer, and `system-status` adds the CPU/RAM line next
to it.

### Server plugins (esp-buddy)

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

Two shapes live here:

- **Server plugin** — `plugins/<name>/` with `index.js`
  (`Plugin.define({ id: "<name>", ... })`), `package.json` (private),
  `README.md`, and `test/harness.mjs` (+ `mock-loader.mjs`).
- **CLI plugin** — `plugins/<name>/` with `tui.ts` (plus `src/`), a
  `package.json` exposing `"./tui"`, `README.md`, an offline
  `test/harness.mjs`, and a `scripts/install.mjs` that registers the folder in
  `cli.json`. See `plugins/go-usage` for the reference layout.

Conventions: helper files `<name>-send.*`, debug log `<name>-debug.log` under
`~/.config/opencode/plugins/`, env vars `<NAME>_*`, and `bun run test` inside
the plugin folder must print `ALL TESTS PASSED`.

Read `AGENTS.md` first — it has the verified OpenCode V2 API facts and the
rules (including: never commit/push without an explicit order).

## Layout

```
plugins/
  esp-buddy/
    index.js            # server plugin (Plugin.define id "esp-buddy")
    esp-buddy-send.mjs  # fast sender (node + serialport, ~200ms)
    esp-buddy-send.ps1  # fallback sender (powershell, ~340ms)
    test/harness.mjs    # offline state-machine test (~51 assertions)
  go-usage/
    tui.ts              # CLI plugin entry (prompt footer slot, /go-usage)
    src/                # auth (device flow), service, status, one-line model, UI
    scripts/install.mjs # registers the folder in cli.json
    test/harness.mjs    # offline H/W/M line/auth/service/install test
  system-status/
    tui.ts              # CLI plugin entry (prompt footer slot)
    src/                # CPU/RAM collector, model, options, UI
    scripts/install.mjs # registers the folder in cli.json
    test/harness.mjs    # offline collector/parsers/model/install test
install.ps1             # copy-mode installer for ~/.config/opencode/plugins
```
