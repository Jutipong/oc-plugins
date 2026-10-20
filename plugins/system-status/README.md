# system-status

CPU load and RAM usage as a single line in the OpenCode V2 CLI **prompt
footer**:

```text
[CPU:37% · RAM:62%]
```

- `CPU` — overall busy time across all cores (smoothed, 0–100%).
- `RAM` — used physical memory (0–100%).
- Labels are muted, values carry the threshold tone, brackets and ` · `
  separators stay faint. The style matches `go-usage`.
- Missing values render as `—`.
- A collector failure prefixes the line with `! ` and keeps the last values.

| Tone | CPU / RAM |
| --- | --- |
| green | < 50% |
| yellow | 50–79% |
| red | ≥ 80% |

## Where the numbers come from

| Value | Source | Cadence |
| --- | --- | --- |
| CPU | `os.cpus()` time deltas, EMA-smoothed | every `interval` (2 s) |
| RAM | macOS: `vm_stat` active + wired + compressed; Windows/other: `total - freemem` | every 5 s |

Sampling is reference-counted: it starts when the footer mounts and stops a
few seconds after it unmounts, so nothing runs while you are on the home
screen. No commands, no storage, no network.

## Install

Requires OpenCode **V2** (tested on v2.1.1). The plugin is CLI-only, so it is
registered in `cli.json`, not `opencode.json`:

```sh
cd plugins/system-status
node scripts/install.mjs            # add/update this checkout in cli.json
node scripts/install.mjs --dry-run  # preview only
node scripts/install.mjs --remove   # unregister
```

The script backs up `cli.json` and preserves other plugin entries:

```jsonc
// ~/.config/opencode/cli.json (macOS)
// %USERPROFILE%\.config\opencode\cli.json (Windows)
{
  "plugins": [
    {
      "package": "file:///Users/js.dev/SourceCode/oc-plugins/plugins/system-status",
      "options": { "interval": 2 }
    }
  ]
}
```

Then restart OpenCode and open a session — the line appears in the prompt
footer next to any other footer plugins (such as `go-usage`).

## Options and environment

Options go in the `cli.json` plugin entry; `SYSTEM_STATUS_*` environment
variables are fallbacks (options win).

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `interval` | `SYSTEM_STATUS_INTERVAL` | `2` | Seconds between samples (clamped 1–10) |
| `colorMode` | `SYSTEM_STATUS_COLOR_MODE` | `"mole"` | `mole` (fixed palette) / `theme` |
| `debug` | `SYSTEM_STATUS_DEBUG=1` | `false` | Log to `system-status-debug.log` |

Debug logs: `~/.config/opencode/plugins/system-status-debug.log`
(truncated at 512 KB, off unless enabled).

## States

| Footer shows | Meaning |
| --- | --- |
| `[CPU:— · RAM:—]` | Before the first sample |
| `[CPU:37% · RAM:62%]` | Live values |
| `! [CPU:37% · RAM:62%]` | Collector error; previous values kept |

## Tests

```sh
cd plugins/system-status
node test/harness.mjs   # or: bun run test
```

Offline only: CPU delta math, `vm_stat` parsing, threshold tones, missing
values, stale prefix, width clipping, option/env resolution, install helper
patching, collector lifecycle with injected commands, packaging and source
hygiene. Must print `ALL TESTS PASSED (N assertions)`.

## Notes

- Standalone: it does not import or depend on the other plugins; the visual
  style (and the Mole palette) matches the other CLI plugins.
- In the prompt footer it coexists with `go-usage`; if both lines feel crowded
  on a narrow terminal, move one plugin to a different slot.
