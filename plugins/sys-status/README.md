# sys-status

A Mole-style system status dashboard for the **OpenCode V2 terminal sidebar**.
Native collectors for **macOS and Windows** — no `mo`, no Homebrew tools, no
npm dependencies. CPU, memory, disk, power and network with a transparent
health score.

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

### Full sidebar (`sidebarMode: "full"`)

CPU, memory, disk, power and network cards stacked into the 36-column
sidebar. `frame`, `barStyle`, `colorMode`, `cores` and `rowSpacing` all
apply. There is no health or machine-identity header; the sidebar starts
straight with the CPU card:

```text
╭─ ◈ System ───────────────────────╮
│ ◉ CPU         Apple M1 · 2.4 GHz │
│ Total  █████░░░░░░░░░░░░░░ 29.1% │
│ Core1  ████████░░░░░░░░░░░ 44.4% │
│ Core2  ███████░░░░░░░░░░░░ 40.9% │
│ Core3  ███████░░░░░░░░░░░░ 40.4% │
│ Core4  ███████░░░░░░░░░░░░ 39.8% │
│   load 3.41 / 3.62 / 3.80        │
│ ──────────────────────────────── │
│ ◫ Memory       10.2 GB / 16.0 GB │
│ Used   ████████████░░░░░░░ 63.6% │
│ Cache 3.2 GB · Avail 5.8 GB      │
│ ──────────────────────────────── │
│ ▥ Disk       147.3 GB / 228.3 GB │
│ INTR   █████████████░░░░░░   73% │
│ I/O    R 0.40 MB/s · W 1.7 MB/s  │
│ ──────────────────────────────── │
│ ◪ Power                     100% │
│ Health  ███████████████░░░   88% │
│ Input   10.6W · 0.52A @ 20.3V    │
│ Battery 0W · 0.00A @ 12.7V       │
│ Adapter 57W max · 259 cycles     │
│ ──────────────────────────────── │
│ ⇅ Network             192.0.2.10 │
│ Up                        0 MB/s │
│ Down                   0.01 MB/s │
╰──────────────────────────────────╯
```

- Card titles carry their headline value on the right: CPU chip + speed,
  memory used / total, disk used / total, battery level and network IP.
  Redundant rows are dropped in the sidebar: the disk `Total` and `Used` rows
  (used / total is in the title), the memory `Free` and `Total` rows, the
  power `Level` row (the level is in the title) and the network footer with
  the interface name and IP (the IP is in the title). The power `Level` and
  network footer rows come back automatically when the title has no value to
  show.
- Meters fill the row: label + meter + right-aligned value. They are **19
  cells** wide inside the default 32-cell framed content (23 unframed) — the
  percent never wraps or truncates and every value shares the same right
  column. The network card lists the `Up` / `Down` rates as plain numbers in
  that same right column — no sparklines.
- The CPU card title right-aligns the chip and speed (`◉ CPU … Apple M1 ·
  2.4 GHz`); long chip names are clipped with `…`.
- Fields that no longer fit are dropped instead of mangled: at 32 framed
  columns the `4P+4E` load suffix and the battery `· Charged` status are
  omitted; `frame: "none"` shows them when they fit.
- `rowSpacing` (`compact` / `normal` / `airy`) controls the gaps between
  the cards: none, one blank line, or a faint separator line.
- The full stack is ~23 (`compact`) to ~27 (`airy`) lines tall. If your
  terminal clips the bottom, use `frame: "none"`, `rowSpacing: "compact"`
  or `cores: "p"` (the default) to shorten it.

**No Processes section** — by design.

- The sidebar `PWR` bar is scaled to the adapter's maximum wattage. Its value is
  the **actual system draw** (or battery draw while unplugged), e.g. `19.7W`.

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

Any option from the table below can be written in the same command:

```sh
# full stacked dashboard, like the reference screenshot
node scripts/install.mjs --sidebar-mode full --row-spacing airy --spacing normal

node scripts/install.mjs --frame none --bar-style solid --cores all
node scripts/install.mjs --interval 5 --placement bottom
```

| Flag | Values | Option |
|---|---|---|
| `--interval` | seconds, 1–10 | `interval` |
| `--spacing` | `compact` \| `normal` \| `airy` | `spacing` |
| `--row-spacing` | `compact` \| `normal` \| `airy` | `rowSpacing` |
| `--bar-style` | `mole` \| `solid` | `barStyle` |
| `--frame` | `rounded` \| `heavy` \| `none` | `frame` |
| `--color-mode` | `mole` \| `theme` | `colorMode` |
| `--sidebar-mode` | `compact` \| `full` | `sidebarMode` |
| `--cores` | `p` \| `all` | `cores` |
| `--placement` | `top` \| `bottom` | `placement` |

Unknown flags or invalid values are ignored, and re-running the script merges
into the options already in `cli.json` — it never resets the other settings.
The script defaults to `sidebarMode: "compact"`; pass `--sidebar-mode full` on
a new machine to get the stacked dashboard cards.

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
  `options.sidebar` is `false`). `sidebarMode: "compact"` (default) shows the
  single summary block; `sidebarMode: "full"` stacks the full dashboard cards
  into the sidebar instead.

## Options (cli.json)

```jsonc
{
  "package": "file:///path/to/plugins/sys-status",
  "options": {
    "interval": 2,          // seconds between samples (1-10)
    "sidebar": true,        // show the sidebar block
    "sidebarMode": "compact", // "compact" (summary block) | "full" (stacked dashboard)
    "placement": "top",     // "top" | "bottom" of sidebar.content
    "spacing": "compact",   // compact block spacing: "compact" | "normal" | "airy"
    "rowSpacing": "airy",   // full sidebar card gaps (falls back to `spacing`)
    "cores": "p",           // CPU cores (full sidebar): "p" (summary) | "all"
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
- The health score only appears in the unframed (`frame: "none"`) header line;
  the framed block keeps just the `◈ System` title

## Colors

`colorMode: "mole"` (default) uses Mole's fixed palette:

| Tone | Hex | Used for |
|---|---|---|
| success | `#A5D6A7` | CPU/RAM/DSK/PWR load below 50%, battery ≥50% |
| warning | `#FFA94D` | CPU/RAM/DSK/PWR load 50–79%, battery 20–49% |
| error | `#FF5F5F` | CPU/RAM/DSK/PWR load 80%+, battery below 20% |
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
- Full sidebar (`sidebarMode: "full"`) keeps the label, meter and a
  right-aligned value on one line; the meter is **19 cells** framed / 23
  unframed (18/22 under the 8-cell power labels) so the row is full
- `█` for whole cells and `░` for the empty track (full blocks, no partial
  eighth-block edge)
- CPU / memory / disk / PWR load: green below 50%, yellow 50–79%, red at 80%+
- Battery level and health: red below 20%, yellow 20–49%, green 50%+
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

The Power card shows `Input`, `Battery`, and `Adapter` lines. On battery power
the `Input` line is omitted (no AC telemetry) and `Battery` shows the discharge
draw; battery cycles move to their own `Cycles` row when no adapter is attached.
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
```

Debug logs rotate at 512 KB and never include metric payloads.

## Tests

```sh
cd plugins/sys-status
bun run test        # or: node test/harness.mjs — prints ALL TESTS PASSED
```

The harness is fully offline: formatters, health, macOS/Windows parsers,
sidebar models and the cli.json install helpers. Fixtures are synthetic
(no real hostnames, IPs or serial numbers). It also asserts that no runtime
source references the Mole CLI.

## Limitations

- Linux is not supported yet (the sidebar shows a friendly message).
- Windows live verification is manual: run `node test/collect-smoke.mjs` on a
  Windows machine; the parser fixtures cover the documented output shapes.
- Windows battery cycle count and battery temperature are not exposed by the
  OS; those fields show as missing instead of inventing values.

## License / attribution

Original plugin code. Mole is GPL-3.0 and is only the visual inspiration for
the dashboard; the plugin does not use, require, or copy Mole. "Mole" is a
trademark of its author; this project is unofficial and not affiliated.
