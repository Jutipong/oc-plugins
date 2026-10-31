# go-usage

OpenCode **Go** plan usage — plus a live **output speed** meter — as a single
line in the OpenCode V2 CLI **prompt footer**:

```text
[H:92% · W:45% · M:44% · ⚡120 tok/s]
```

- `H` — rolling 5-hour meter, `W` — weekly, `M` — monthly (same order as the
  Console cards).
- Each percentage is colored with the shared threshold buckets: green below
  50%, yellow 50–79%, red 80% and above. The brackets and `·` separators stay
  faint and the `H:`/`W:`/`M:` labels stay muted, so the numbers are the
  loudest part of the line.
- `⚡120 tok/s` — the live generation speed of the session in the current
  footer. The field is always present while the meters row is live: it shows
  `⚡0 tok/s` in muted gray when the session is idle, and the value is toned
  by speed while generating: **green** ≥ 100 tok/s, **deep green** ≥ 150 tok/s
  (fixed `#4CAF50` in both color modes), **amber** 60–99 tok/s, **red** < 60
  tok/s. It is the first field dropped on narrow terminals.
  It is an estimate: the runtime exposes no token counters mid-stream, so the
  plugin converts streamed delta characters with a chars-per-token factor
  (~3.5 default; Thai text packs ~2.4). Set `tpsFactor` if your language
  skews the number.
- A meter without data renders as `H:—`; with no data at all the line is
  `[H:— · W:— · M:—]`.
- When the latest refresh failed but values are kept, the line is prefixed with
  a warning `! `: `! [H:92% · W:45% · M:44%]`.
- Non-ready states always show a short marker: `Go …` (signed in / loading),
  `Go —` (not connected or no subscription), `Go !` (fetch error). The speed
  field only joins the ready meters row.

No frame, no bars, no sidebar: this plugin owns the `prompt.footer.status` slot
only.

## Design

This plugin owns the prompt footer only: one OAuth device login, one token /
payload store (`plugin.go-usage.*`), and one 5-minute polling loop. It replaces
the old sidebar `go-usage` plugin; the sidebar, frame and bar code is gone.

## Commands

| Command / palette      | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `/go-usage`            | Details dialog — **or starts the login when signed out** |
| `/go-usage-login`      | Start the device login (palette: **Go usage: connect**)  |
| `/go-usage-logout`     | Forget the stored Console session (palette: **Go usage: disconnect**) |
| `/go-usage-refresh`    | Fetch immediately (palette: **Go usage: refresh**)       |

The legacy argument form still works: `/go-usage login`,
`/go-usage logout`, `/go-usage refresh`.

## Install

Requires OpenCode **V2** (tested on v2.1.1). The plugin is CLI-only, so it is
registered in `cli.json`, not `opencode.json`.

```sh
cd plugins/go-usage
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
      "package": "file:///Users/js.dev/SourceCode/oc-plugins/plugins/go-usage",
      "options": { "interval": 300 }
    }
  ]
}
```

Then restart OpenCode, open a session, and run `/go-usage` — when signed
out it starts the login directly. The line appears in the prompt footer, so it
is visible while composing a message (not on the home screen).

## Options and environment

Options go in the `cli.json` plugin entry; `GO_USAGE_*` environment
variables are fallbacks (options win).

| Option        | Env                          | Default                       | Meaning                        |
| ------------- | ---------------------------- | ----------------------------- | ------------------------------ |
| `interval`    | `GO_USAGE_INTERVAL`     | `300` (5 min)                 | Poll seconds (clamped 15–3600) |
| `baseUrl`     | `GO_USAGE_BASE_URL`     | `https://opencode.ai/console` | Console base URL               |
| `org`         | `GO_USAGE_ORG`          | token org                     | Explicit `x-org-id` override   |
| `colorMode`   | `GO_USAGE_COLOR_MODE`   | `"mole"`                      | `mole` (fixed palette, like the other CLI plugins) / `theme` |
| `tps`         | `GO_USAGE_TPS=0`        | `true`                        | Show the live `⚡tok/s` field   |
| `tpsFactor`   | `GO_USAGE_TPS_FACTOR`   | `3.5`                         | Chars per token for the estimate (clamped 1–8) |
| `openBrowser` | `GO_USAGE_NO_OPEN=1`    | `true`                        | Auto-open the login URL        |
| `debug`       | `GO_USAGE_DEBUG=1`      | `false`                       | Log to `go-usage-debug.log` |

Debug logs: `~/.config/opencode/plugins/go-usage-debug.log` (truncated at
512 KB, off unless enabled).

## States

| Footer shows                | Meaning                                               |
| --------------------------- | ----------------------------------------------------- |
| `Go …`                      | First fetch in flight                                 |
| `Go —`                      | No session yet, or the account has no Go subscription |
| `Go !`                      | Fetch failed and there are no cached values           |
| `[H:… · W:… · M:… · ⚡n tok/s]` | Live values + this session is generating           |
| `[H:… · W:… · M:… · ⚡0 tok/s]` | Live values, session idle (speed muted)            |
| `! [H:… · W:… · M:… · ⚡n tok/s]` | Refresh failed; last known values are kept       |
| `[H:… · W:…]`               | Too narrow: the speed field, then `M`, were dropped   |

## How it gets the data

- Login uses the same OAuth device flow as the OpenCode CLI's "OpenCode Console
  account" connection (client `opencode-cli`); tokens are stored in this
  plugin's own CLI storage and refreshed automatically.
- Meters come from `GET https://opencode.ai/console/api/go/status`, the route
  the Console SPA renders from. `GO_USAGE_BASE_URL` / the `baseUrl` option
  can point elsewhere if it ever moves.
- The speed meter follows the TUI event stream
  (`context.data.listen`): `session.text.delta` / `session.reasoning.delta`
  feed a 2-second sliding window, `session.step.started`/`execution.*` open
  and close it, and the value is published at most twice a second. The footer
  only shows the rate of the session it renders (the slot's `sessionID`).
- API keys (`sk-…` in `auth.json`) do not work on the Console API; only the
  device-flow session works. The plugin never reads your other credentials.

## Tests

```sh
cd plugins/go-usage
node test/harness.mjs   # or: bun run test
```

Offline only: H/W/M line rendering, per-meter tones, missing meters, stale
prefix, every phase, width clipping, detail dialog text, smart command routing,
device-flow state machine (`authorization_pending`, `slow_down` backoff,
expiry, cancel, refresh), 401 → refresh → retry, options/env resolution,
live speed tracker math (window, freshness, per-session isolation, factor
clamping) and its footer field/tier tones, install helper patching, packaging,
and source hygiene. Must print `ALL TESTS PASSED (N assertions)`.

## Notes

- Unofficial integration with the Console UI's own API. The plugin only reads
  usage; it never subscribes, cancels, or changes billing.
- The device login is the same one the OpenCode CLI itself uses for its Console
  account connection; sessions are independent per client.
- The prompt footer is one narrow row, so the line is clipped to 40 cells;
  trailing fields are dropped whole (the speed field first, then `M`, then
  `W`) and the `[...]` brackets are always kept balanced.
- The speed number is an estimate derived from streamed characters, not the
  provider's token counter (that only arrives when a step ends). Treat it as
  a relative indicator; the built-in assistant footer still shows the exact
  per-message average.
