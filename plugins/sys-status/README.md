# sys-status

A Mole-style system status dashboard for the **OpenCode V2 terminal sidebar**
and session panel. Native collectors for **macOS and Windows** — no `mo`, no
Homebrew tools, no npm dependencies. CPU, memory, disk, power and network with
a transparent health score.

> Visual inspiration: [Mole](https://github.com/tw93/mole)'s `mo status`
> dashboard. This plugin is an independent implementation (no Mole code is
> copied or required) and is not affiliated with Mole.

## What you get

### Sidebar (framed, always visible inside a session)

```text
╭─ ◈ System ───────────────────────╮
│ ◉ CPU Apple M1 · 2.4 GHz    22.0%│
│ ███████░░░░░░░░░░░░░░░░░░░░░░░░░░│
│ ◫ RAM 16.0 GB               63.0%│
│ ████████████████████░░░░░░░░░░░░░│
│ ▥ DSK                         73%│
│ ███████████████████████░░░░░░░░░░│
│ ──────────────────────────────── │
│ ◪ PWR                       19.7W│
│ ██████████░░░░░░░░░░░░░░░░░░░░░░░│
│ ⇅ NET      ↓ 0 MB/s  ↑ 0 MB/s│
╰──────────────────────────────────╯
```

### `/sys` panel (press `f` for fullscreen)

```text
Status  Health ● 97  Excellent: Restart Recommended
MacBook Air · Apple M1, 7GPU · RAM 16.0 GB · Disk 228.3 GB · 60Hz
macOS 27.0.1 · up 14d 16h
────────────────────────────────────────────────────────────────
◉ CPU                                   ◫ Memory
Total  ███░░░░░░░░░░░░░░░  29.1%         Used   ██████░░░░░░░░░░  63.4%
Core1  ████████░░░░░░░░░░  44.4%         Free   ██████░░░░░░░░░░  36.6%
Core2  ████████░░░░░░░░░░  40.9%         Total  10.1 GB / 16.0 GB
Core3  ████████░░░░░░░░░░  40.4%         Cache  3.4 GB · Avail 5.9 GB
Core4  ███████░░░░░░░░░░░  39.8%
  load 3.41 / 3.62 / 3.80 · 4P+4E
────────────────────────────────────────────────────────────────
▥ Disk                                  ◪ Power
INTR   ███████░░░░░░░░░░░  73%           Level   ██████████████████ 100%
Total  228.3 GB                         Health  ███████████████░░░  88%
Used   147G used · 57G free             Input   10.6W · 0.52A @ 20.3V
I/O    R 0.2 MB/s · W 0.0 MB/s          Battery 0W · 0.00A @ 12.7V · Charged
                                        Adapter 57W max · 259 cycles
────────────────────────────────────────────────────────────────
⇅ Network
Down   ▁▂▁▇▃▁▁▁▁▁▁▁▁▁▁  0.01 MB/s
Up     ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁  0.00 MB/s
en0 · 192.0.2.10
```

**No Processes section** — by design.

- The sidebar `PWR` bar is scaled to the adapter's maximum wattage. Its value is
  the **actual system draw** (or battery draw while unplugged), e.g. `19.7W`.
  The full panel shows the live watts, amps and volts.

## Install

Requires OpenCode **V2** (tested on v2.0.32). The plugin is CLI-only, so it is
registered in `cli.json`, not `opencode.json`.

### One command (macOS + Windows)

```sh
cd plugins/sys-status
node scripts/install.mjs            # add/update this checkout in cli.json
node scripts/install.mjs --dry-run  # preview only
node scripts/install.mjs --remove   # unregister
```

The script backs up `cli.json`, preserves other plugin entries, and writes an
entry like:

```jsonc
// ~/.config/opencode/cli.json (macOS)
// %USERPROFILE%\.config\opencode\cli.json (Windows)
{
  "plugins": [
    {
      "package": "file:///Users/js.dev/SourceCode/oc-plugins/plugins/sys-status",
      "options": { "interval": 2 }
    }
  ]
}
```

Then **restart OpenCode**. The folder is loaded in place, so edits to the
plugin source are picked up after a restart (local dependencies are not
watched).

No `bun install` is needed: OpenCode V2 resolves `@opencode/plugin/tui`,
`solid-js` and `@opentui/*` from its own runtime when loading local CLI
plugins.

Make sure the sidebar is not disabled:

```jsonc
{ "session": { "sidebar": "auto" } }
```

## Usage

- **Sidebar** — renders automatically in every session (unless
  `options.sidebar` is `false`).
- **`/sys`** (alias `/system`) — opens the full dashboard panel in the current
  session. Also available from the command palette as **System status**.
- Panel keys: `f` fullscreen · `c` cycle CPU cores (summary/all) · `r` restart
  the collector · `q` close.
- The panel replaces the sidebar while open (OpenCode's right pane can show
  one of panel/sidebar/terminal). On narrow terminals it opens fullscreen
  automatically.

## Options (cli.json)

```jsonc
{
  "package": "file:///path/to/plugins/sys-status",
  "options": {
    "interval": 2,          // seconds between samples (1-10)
    "sidebar": true,        // show the compact sidebar block
    "placement": "top",     // "top" | "bottom" of sidebar.content
    "spacing": "compact",   // "compact" | "normal" | "airy"
    "cores": "p",           // panel CPU cores: "p" (summary) | "all"
    "barStyle": "mole",     // "mole" (█ + ░ track) | "solid" (filled bar only)
    "frame": "rounded",     // "rounded" | "heavy" | "none"
    "colorMode": "mole"     // "mole" (fixed palette) | "theme" (follow OpenCode theme)
  }
}
```

## Where the data comes from

No external binaries beyond what macOS and Windows already ship.

| Metrics | macOS | Windows |
|---|---|---|
| CPU / per-core | `os.cpus()` deltas | `os.cpus()` deltas |
| Load | `sysctl vm.loadavg` | not available (shows core count) |
| Memory | `vm_stat` + `sysctl hw.memsize` | `Win32_OperatingSystem` + `Win32_PerfFormattedData_PerfOS_Memory` |
| Disk | `df -k /System/Volumes/Data` | `Win32_LogicalDisk` (system drive) |
| Disk I/O | `ioreg IOBlockStorageDriver` deltas | `Win32_PerfFormattedData_PerfDisk_PhysicalDisk` |
| Network | `netstat -ib` + `route` | `Get-NetAdapterStatistics` + `Get-NetIPConfiguration` |
| Power | `pmset -g batt` + `system_profiler SPPowerDataType` | `Win32_Battery` |
| Hardware | `sysctl` + `system_profiler` (cached 10 min) | `Win32_ComputerSystem` / `Processor` / `VideoController` (cached 10 min) |

Windows uses one long-lived PowerShell process that streams JSON every ~3 s
(`-NoProfile -NonInteractive -ExecutionPolicy Bypass`); CPU and memory are
sampled in-process. macOS runs short built-in commands with per-command
timeouts. All failures keep the previous value and never crash the TUI.

## Frame

The sidebar block draws its own frame, matching the go-usage plugin:

- `frame: "rounded"` (default) uses `╭─╮│╰╯`; `heavy` uses `┏━┓┃┗┛`;
  `none` removes the frame and returns to the plain 36-column header layout
- The top border shows `◈ System` on the left; no update clock is shown
- The CPU row is labelled `CPU` with the model and reported speed, e.g.
  `CPU Apple M1 · 2.4 GHz`; the MacBook model name is not repeated here
- Metric labels carry Mole icons (`◉ CPU`, `◫ RAM`, `▥ DSK`, `◪ PWR`,
  `⇅ NET`) and the percentage/watt values are bold
- A faint separator line divides the resource group (CPU/RAM/DSK) from the
  power/network group
- The memory row is labelled `RAM` with its capacity (e.g. `RAM 16.0 GB`) and
  the usage percentage on the right
- Framed content is **32 cells wide** (36 total − 2 border − 2 padding);
  `frame: "none"` uses the full 36 cells
- The health score/message is not repeated inside the frame; open `/sys` for
  the full health card

## Colors

`colorMode: "mole"` (default) uses Mole's fixed palette:

| Tone | Hex | Used for |
|---|---|---|
| success | `#A5D6A7` | CPU/RAM/DSK below 60%, battery ≥50%, healthy load |
| warning | `#FFA94D` | CPU/RAM/DSK 60–85%, battery 20–50% |
| error | `#FF5F5F` | CPU/RAM/DSK ≥85%, battery below 20% |
| accent | `#C79FD7` | `◈ System` title |
| border | `#404040` | frame |
| muted | `#737373` | labels / track accents |

`colorMode: "theme"` follows the active OpenCode theme instead (adapts to
light/dark). The fixed Mole palette does not adapt to light themes.

## Bar style

The default `barStyle: "mole"` mirrors Mole's gauges:

- Sidebar meters use a **full-width bar on its own line** below a
  label/value line — the same two-line layout as the go-usage plugin
- Framed sidebar bars are 32 cells; `frame: "none"` uses 36 cells
- Panel bars are 20–24 cells depending on width
- `█` for whole cells and `░` for the empty track (full blocks, no partial
  eighth-block edge)
- CPU / memory / disk: green below 60%, yellow 60–85%, red at 85%+
- Battery level and health: red below 20%, yellow 20–50%, green 50%+
- `barStyle: "solid"` removes the `░` track (filled blocks only) for a quieter
  look; the health/percentage values are unchanged.

## Power / current

On macOS the plugin reads live power telemetry from `ioreg` (no `sudo`):

| Field | Source | Example |
|---|---|---|
| System draw | `PowerTelemetryData.SystemPowerIn` (mW) | `10.6W` |
| System current | `PowerTelemetryData.SystemCurrentIn` (mA) | `0.52A` |
| System voltage | `PowerTelemetryData.SystemVoltageIn` (mV) | `20.3V` |
| Battery draw | `PowerTelemetryData.BatteryPower` (mW) | `0W` on AC |
| Battery current/voltage | `Amperage` / `Voltage` | `0.00A @ 12.7V` |
| Adapter maximum | `AdapterDetails.Watts` | `57W max` |

The `/sys` panel Power card shows `Input`, `Battery`, and `Adapter` lines.
Windows' `Win32_Battery` does not expose instantaneous current/wattage, so the
`Input` line is omitted and `Battery` shows status/level only.

## Health score

An original, transparent heuristic (not a port of Mole's GPL-3.0 scoring):

| Component | Penalty |
|---|---|
| CPU | 0 at ≤50%, up to −25 at 100% |
| Memory | 0 at ≤70%, up to −25 at 100% |
| Disk | 0 at ≤80%, up to −20 at 100% |
| Battery health | up to −15 below 80%; −5 when cycles >900 |
| Disk I/O | −5 above 200 MB/s, −10 above 500 MB/s |
| Uptime | −2 above 7 d, −3 above 14 d, −7 above 30 d |

Labels: `Excellent` ≥85 · `Good` ≥65 · `Fair` ≥45 · `Poor` below. The message
picks the first problem: `High CPU`, `High Memory`, `Disk Almost Full`,
`Service Battery`, `Restart Recommended`, otherwise `All systems normal`.

On a healthy MacBook Air M1 (CPU ~30%, memory ~60%, disk ~73%, battery health
88%, uptime ~14 days) the score reads **97 / Excellent / Restart
Recommended** — matching the reference dashboard's mood.

## Debugging

```sh
SYS_STATUS_DEBUG=1 opencode        # writes ~/.config/opencode/plugins/sys-status-debug.log
node test/collect-smoke.mjs 8      # live sanitized snapshot (macOS/Windows)
node test/collect-smoke.mjs --json # same, pretty JSON
SYS_STATUS_AUTO_PANEL=1 opencode   # auto-open /sys once a session is available (smoke tests)
```

Debug logs rotate at 512 KB and never include metric payloads.

## Tests

```sh
cd plugins/sys-status
bun run test        # or: node test/harness.mjs — prints ALL TESTS PASSED
```

The harness is fully offline: formatters, health, macOS/Windows parsers,
sidebar/panel models and the cli.json install helpers. Fixtures are synthetic
(no real hostnames, IPs or serial numbers). It also asserts that no runtime
source references the Mole CLI.

## Limitations

- Linux is not supported yet (the sidebar shows a friendly message).
- Windows live verification is manual: run `node test/collect-smoke.mjs` on a
  Windows machine; the parser fixtures cover the documented output shapes.
- Windows battery cycle count and battery temperature are not exposed by the
  OS; those fields show as missing instead of inventing values.
- The full 2-column panel needs ~100+ columns; narrow panels render a
  single-column layout automatically.

## License / attribution

Original plugin code. Mole is GPL-3.0 and is only the visual inspiration for
the dashboard; the plugin does not use, require, or copy Mole. "Mole" is a
trademark of its author; this project is unofficial and not affiliated.
