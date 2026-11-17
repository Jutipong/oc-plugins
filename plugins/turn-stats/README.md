# turn-stats

Per-turn session meters as one **right-aligned line above the input prompt**
(`session.composer.top`):

```text
⏱ 00:00 · ▤ 99% · ⚡  0t/s
```

- `⏱ 00:00` — wall-clock time of the current **turn** (`execution.started` →
  `succeeded` / `failed` / `interrupted`), including tool calls, retries and
  child sessions. It counts up live while the turn runs, then freezes in a
  muted tone until the next turn starts. A session with no turn yet reads
  `⏱ 00:00`. Format: `MM:SS`, minutes keep counting past 99 (`75:12`) so the
  field never changes width.
- `▤ 99%` — cache hit of **this session**: `cache.read / (cache.read + input)`
  over every step the runtime has counted (writes are a stored miss, so they
  stay out of the denominator). Green ≥ 80%, plain 50–79%, amber < 50%;
  `▤   —` until the first step ends.
- `⚡103t/s` — the live generation speed of the session in the current prompt.
  The field is always present: it shows `⚡  0t/s` in muted gray when the
  session is idle, and the value is toned by speed while generating: **pink**
  ≥ 200 t/s (Dracula `#FF79C6`), **deep green** 150–199 t/s (fixed
  `#4CAF50`), **green** 100–149 t/s, **amber** 60–99 t/s, **red** < 60 t/s.
  It is an estimate: the runtime exposes no token counters mid-stream, so the
  plugin converts streamed delta characters with a chars-per-token factor
  (~3.5 default; Thai text packs ~2.4). Set `tpsFactor` if your language
  skews the number.
- Every number is padded to a fixed width (`⏱ 00:05` / `⏱ 01:05` / `⏱ 75:12`,
  `▤  3%` / `▤ 99%` / `▤100%`, `⚡  0` / `⚡ 45` / `⚡103`), so a value that
  gains a digit never shifts the row.
- Labels are the muted icons and ` · ` separators stay faint. The style
  matches the other CLI plugins (`mole` palette by default). There are no
  brackets and no frame.
- The row caps at 45 cells and drops trailing fields whole when the terminal
  is narrower: `⚡` first, then `▤`, then `⏱`.
- The line only shows the session it renders (the slot's `sessionID`); child
  sessions keep their own clocks and never leak into the parent's row.

No commands, no storage, no network: this plugin owns the
`session.composer.top` slot only.

## Install

Requires OpenCode **V2** (tested on v2.2.5). The plugin is CLI-only, so it is
registered in `cli.json`, not `opencode.json`:

```sh
cd plugins/turn-stats
node scripts/install.mjs            # add/update this checkout in cli.json
node scripts/install.mjs --dry-run  # preview only
node scripts/install.mjs --remove   # unregister
```

The script backs up `cli.json`, preserves other plugin entries, and writes:

```jsonc
// ~/.config/opencode/cli.json (macOS)
// %USERPROFILE%\.config\opencode\cli.json (Windows)
{
  "plugins": [
    {
      "package": "file:///Users/js.dev/SourceCode/oc-plugins/plugins/turn-stats"
    }
  ]
}
```

Then reload OpenCode (`/reload`). The line appears above the prompt of every
session (not on the home screen).

## Options and environment

Options go in the `cli.json` plugin entry; `TURN_STATS_*` environment
variables are fallbacks (options win).

| Option      | Env                      | Default | Meaning |
| ----------- | ------------------------ | ------- | ------- |
| `colorMode` | `TURN_STATS_COLOR_MODE`  | `"mole"` | `mole` (fixed palette, like the other CLI plugins) / `theme` |
| `tpsFactor` | `TURN_STATS_TPS_FACTOR`  | `3.5`   | Chars per token for the speed estimate (clamped 1–8) |
| `debug`     | `TURN_STATS_DEBUG=1`     | `false` | Log to `turn-stats-debug.log` |

Debug logs: `~/.config/opencode/plugins/turn-stats-debug.log` (truncated at
512 KB, off unless enabled).

## States

| Row shows | Meaning |
| --- | --- |
| `⏱ 00:00 · ▤   — · ⚡  0t/s` | Fresh session: no step, no turn yet |
| `⏱ 00:45 · ▤ 87% · ⚡103t/s` | Live turn: elapsed time, cache hit, speed |
| `⏱ 01:05 · ▤ 87% · ⚡  0t/s` | Turn ended: last turn time kept, muted |
| `⏱ 00:45 · ▤ 87%` | Narrow terminal: `⚡` dropped whole |
| `⏱ 00:45` | Narrower: `▤` dropped too |

## How it gets the data

- Everything follows the TUI event stream (`context.data.listen`), filtered
  to the plugin's location directory:
  - `session.text.delta` / `session.reasoning.delta` feed a 2-second sliding
    window (published at most twice a second); the footer only shows the rate
    of the session it renders.
  - `session.step.ended` carries the per-step token counters (`input`,
    `cache.read`, `cache.write`), which are summed per session. The map is
    bounded to 32 sessions (least recently used evicted); a re-delivered
    durable step (same `assistantMessageID`) is counted once.
  - `session.execution.started` starts the turn clock; `succeeded` / `failed`
    / `interrupted` (and `idle` as a backstop) freeze it. A replayed
    `execution.started` while the turn is already running does not reset it;
    `session.step.started` restarts the speed window only.
- The clock redraws at most once a second (the 500 ms tick publishes only when
  the visible second changes).

## Tests

```sh
cd plugins/turn-stats
node test/harness.mjs   # or: bun run test
```

Offline only: cache-hit math and per-session accumulation (LRU, replay
dedupe), speed tracker window/freshness/isolation/factor clamp, turn timer
math and formats, the runtime event feed (directory filter, turn start/end,
step-start isolation, second-granularity publishing, publisher failure
logging), line rendering (exact segments, tones, fixed-width padding, drop
order), option/env resolution, install helper patching,
packaging and source hygiene. Must print `ALL TESTS PASSED (N assertions)`.

## Notes

- Standalone: it does not import or depend on the other plugins; the visual
  style (and the Mole palette) matches the other CLI plugins.
- The speed number is an estimate derived from streamed characters, not the
  provider's token counter (that only arrives when a step ends). Treat it as
  a relative indicator; the built-in assistant footer still shows the exact
  per-message average.
- Right alignment relies on the host stacking slot content in a full-width
  column: the row box stretches and `justifyContent: flex-end` pins the line
  to the right edge. The slot receives no width, so the model keeps its own
  45-cell cap.
