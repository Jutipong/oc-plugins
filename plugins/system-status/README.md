# system-status

CPU load, RAM usage and network throughput as one line in the prompt footer
(`prompt.footer.status`), next to `go-usage`:

```text
[CPU:37% · RAM:62% · NET:↓1.20M ↑240K]
```

- `CPU` — overall busy time across all cores (smoothed, 0–100%).
- `RAM` — used physical memory (0–100%).
- `NET` — `↓` / `↑` receive / send rate of the default-route interface. The
  smallest unit is `K` (`K` = 1024); raw bytes are never shown (`512 B/s` →
  `0.50K`). Values keep at most two decimals (`0.50K`, `3.40K`, `1.20M`) and
  switch to a whole number from 10 upward (`12K`, `340M`). The space between
  the arrows keeps the two numbers readable.
- Labels are muted, values carry the threshold tone, brackets and ` · `
  separators stay faint. The style matches `go-usage`.
- Missing values render as `—` (`NET:↓— ↑—` before the first network sample).
- A collector failure prefixes the line with `! ` and keeps the last values.

| Tone | CPU / RAM | Network |
| --- | --- | --- |
| green | < 50% | traffic flowing |
| yellow | 50–79% | — |
| red | ≥ 80% | — |
| muted | unknown | idle / unknown |

## Where the numbers come from

| Value | Source | Cadence |
| --- | --- | --- |
| CPU | `os.cpus()` time deltas, EMA-smoothed | every `interval` (2 s) |
| RAM | macOS: `vm_stat` active + wired + compressed; Windows/other: `total - freemem` | every 5 s, value reused in between |
| Network | default-route interface byte counters: macOS `netstat -ibn` + `route -n get default`; Linux `/proc/net/dev` + `/proc/net/route`; Windows `netstat -e` (whole IP stack, no per-interface split); other platforms render `—` | every `interval` (2 s) |

Windows `netstat -e` only reports the totals of the whole IP stack, so the `NET`
field there sums every adapter (loopback included) instead of following the
default route.

Rates are the delta between two samples, so the first sample after start or
after an interface change (Wi-Fi ⇄ VPN) shows `↓— ↑—`. The default-route
lookup is cached for 60 s; if the routed interface is missing from the
counters the busiest non-loopback interface is used.

Each tick is one pass: CPU, then the probes, then a single snapshot, so the row
re-renders at most once per tick and only when a visible value changed. RAM is
read every 5 s on both platforms and its last value is reused in between, which
costs no extra render. The next tick is scheduled after the pass finishes, so a
slow probe can never stack a second pass.

Sampling is reference-counted: it starts when the row mounts and stops a few
seconds after it unmounts, so nothing runs while you are on the home screen. No
network requests, no storage, no long-lived processes, no PowerShell: the only
subprocess is the native `netstat`, about 90 ms per sample.

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

Then reload OpenCode (`/reload`) — the line joins `go-usage` in the footer of
every session.

## Options and environment

Options go in the `cli.json` plugin entry; `SYSTEM_STATUS_*` environment
variables are fallbacks (options win).

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `interval` | `SYSTEM_STATUS_INTERVAL` | `2` | Seconds between samples (clamped 1–10) |
| `network` | `SYSTEM_STATUS_NETWORK` | `true` | Show `NET:↓ / ↑` throughput; `false` / `0` / `off` hides the field and skips the subprocess entirely |
| `colorMode` | `SYSTEM_STATUS_COLOR_MODE` | `"mole"` | `mole` (fixed palette) / `theme` |
| `debug` | `SYSTEM_STATUS_DEBUG=1` | `false` | Log to `system-status-debug.log` |

Debug logs: `~/.config/opencode/plugins/system-status-debug.log`
(truncated at 512 KB, off unless enabled).

## States

| Row shows | Meaning |
| --- | --- |
| `[CPU:— · RAM:— · NET:↓— ↑—]` | Before the first sample |
| `[CPU:37% · RAM:62% · NET:↓1.20M ↑240K]` | Live values |
| `! [CPU:37% · RAM:62% · NET:↓1.20M ↑240K]` | Collector error; previous values kept |
| `[CPU:37% · RAM:62%]` | `network: false`, or too narrow for three fields |

The full line is 38 cells at default width 40; below that the trailing field is
dropped whole (`NET` first, then `RAM`), and the brackets stay balanced.

## Tests

```sh
cd plugins/system-status
node test/harness.mjs   # or: bun run test
```

Offline only: CPU delta math, `vm_stat` / `netstat` / `netstat -e` / `/proc`
parsing, rate math, threshold tones, missing values, stale prefix, width
clipping, one publish per tick and none for an unchanged row, the 5 s RAM
cadence, option/env resolution, install helper patching, collector lifecycle
with injected commands, packaging and source hygiene. Must print
`ALL TESTS PASSED (N assertions)`.

## Notes

- Standalone: it does not import or depend on the other plugins; the visual
  style (and the Mole palette) matches the other CLI plugins.
- The row belongs to `prompt.footer.status`, the same slot as `go-usage`; the
  host decides how the two contributions share the footer.
- There is no keyboard-language field: probing the active layout needs
  `user32` on Windows (a PowerShell spawn that cost seconds and kept a core
  busy) and a HIToolbox read on macOS, which is not worth the price for a
  footer badge.
