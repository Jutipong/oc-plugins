# system-status

CPU load, RAM usage, network throughput and the active keyboard language as one
right-aligned line above the session prompt input (`session.composer.top`):

```text
[CPU:37% · RAM:62% · NET:↓1.2M ↑240K ·  TH ]
```

- `CPU` — overall busy time across all cores (smoothed, 0–100%).
- `RAM` — used physical memory (0–100%).
- `NET` — `↓` / `↑` receive / send rate of the default-route interface, in bytes
  per second (`K` = 1024, one decimal below 10). The space between the arrows
  keeps the two numbers readable.
- ` TH ` — the keyboard language in use (`TH` Thai, `EN` English, …) on a pink
  badge with white text, so the active layout is obvious while typing.
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

The keyboard badge is the one fixed color in the line: `#E91E63` background,
white text (`keyboard` / `onKeyboard` in `src/colors.mjs`). Both color modes use
it — themes do not guarantee a pink hue token. `—` on the badge means the
language is not known yet.

## Where the numbers come from

| Value | Source | Cadence |
| --- | --- | --- |
| CPU | `os.cpus()` time deltas, EMA-smoothed | every `interval` (2 s) |
| RAM | macOS: `vm_stat` active + wired + compressed; Windows/other: `total - freemem` | every 5 s |
| Network | default-route interface byte counters: macOS `netstat -ibn` + `route -n get default`; Linux `/proc/net/dev` + `/proc/net/route`; other platforms render `—` | every `interval` (2 s) |
| Keyboard | macOS: `defaults read com.apple.HIToolbox AppleCurrentKeyboardLayoutInputSourceID`; Windows: PowerShell + user32 `GetKeyboardLayout` of the foreground window; other platforms hide the field | every `interval` (2 s) |

The macOS probe reads the HIToolbox preference, so it needs no Accessibility
permission and follows every layout change (⌃Space / 🌐). Layout names map to a
short code (`ABC`/`US`/`British` → `EN`, `Thai` → `TH`, `French` → `FR`, …);
a layout outside that table shows the first three letters of its name (`SWI`)
rather than a guessed language. The Windows probe is unverified on real
hardware here — it is best-effort and falls back to `—`.

Rates are the delta between two samples, so the first sample after start or
after an interface change (Wi-Fi ⇄ VPN) shows `↓— ↑—`. The default-route
lookup is cached for 60 s; if the routed interface is missing from the
counters the busiest non-loopback interface is used.

Sampling is reference-counted: it starts when the row mounts and stops a few
seconds after it unmounts, so nothing runs while you are on the home screen. No
network requests, no storage, no long-lived processes.

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

Then reload OpenCode (`/reload`) — the line appears above the prompt input of
every session, and the footer keeps whatever other plugins contribute (such as
`go-usage`).

## Options and environment

Options go in the `cli.json` plugin entry; `SYSTEM_STATUS_*` environment
variables are fallbacks (options win).

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `interval` | `SYSTEM_STATUS_INTERVAL` | `2` | Seconds between samples (clamped 1–10) |
| `network` | `SYSTEM_STATUS_NETWORK` | `true` | Show `NET:↓ / ↑` throughput; `false` / `0` / `off` hides the field entirely |
| `keyboard` | `SYSTEM_STATUS_KEYBOARD` | `true` | Show the keyboard language badge; `false` / `0` / `off` hides the field and skips the probe |
| `colorMode` | `SYSTEM_STATUS_COLOR_MODE` | `"mole"` | `mole` (fixed palette) / `theme` |
| `debug` | `SYSTEM_STATUS_DEBUG=1` | `false` | Log to `system-status-debug.log` |

Debug logs: `~/.config/opencode/plugins/system-status-debug.log`
(truncated at 512 KB, off unless enabled).

## States

| Row shows | Meaning |
| --- | --- |
| `[CPU:— · RAM:— · NET:↓— ↑— ·  — ]` | Before the first sample |
| `[CPU:37% · RAM:62% · NET:↓1.2M ↑240K ·  TH ]` | Live values, Thai layout |
| `! [CPU:37% · RAM:62% · NET:↓1.2M ↑240K ·  EN ]` | Collector error; previous values kept |
| `[CPU:37% · RAM:62% · NET:↓1.2M ↑240K]` | `keyboard: false` / unsupported platform, or too narrow |
| `[CPU:37% · RAM:62%]` | `network: false`, or too narrow for three fields |

The full line is 44 cells at default width 46; below that the trailing field is
dropped whole (` TH ` first, then `NET`, then `RAM`), and the brackets stay
balanced.

## Tests

```sh
cd plugins/system-status
node test/harness.mjs   # or: bun run test
```

Offline only: CPU delta math, `vm_stat` / `netstat` / `/proc` parsing, rate
math, threshold tones, missing values, stale prefix, width clipping, the
macOS/Windows keyboard parsers and their layout table, option/env resolution,
install helper patching, collector lifecycle with injected commands, packaging
and source hygiene. Must print `ALL TESTS PASSED (N assertions)`.

## Notes

- Standalone: it does not import or depend on the other plugins; the visual
  style (and the Mole palette) matches the other CLI plugins.
- The row belongs to `session.composer.top`, so it only exists inside a session
  and the prompt footer stays free for `go-usage`.
- The keyboard badge keeps its pink background in `colorMode: "theme"` too;
  change it in `src/colors.mjs` (`keyboard` / `onKeyboard`).
- macOS reports the current *input source*: with an IME (Japanese, Chinese) the
  value can stay on the base layout while the IME composes text.
