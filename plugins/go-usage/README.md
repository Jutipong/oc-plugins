# go-usage

OpenCode **Go** plan usage in the OpenCode V2 terminal sidebar: rolling (5h),
weekly and monthly meters with btop-style bars, percentages and reset
countdowns — the same numbers the Console shows at
<https://opencode.ai/console/…/go>.

```text
╭─ ◈ Go usage ────────── 22:31:05 ─╮
│ Rolling             0h 31m · 92% │
│ █████████████████████████████░░░ │
│ Weekly             12h 12m · 45% │
│ ██████████████░░░░░░░░░░░░░░░░░░ │
│ Monthly             9d 14h · 44% │
│ ██████████████░░░░░░░░░░░░░░░░░░ │
╰──────────────────────────────────╯
```

Bar colors use the same buckets as sys-status (not the Console's): green below
50%, yellow 50–79%, red 80% and above. Bars mirror **sys-status**: whole `█`
cells for the used part (floor, no partial edge) and a `░` track —
`barStyle: "mole"` (default) keeps fill and track in the same threshold color,
`barStyle: "solid"` leaves the remainder blank.

Colors follow sys-status too — `colorMode: "mole"` (default) uses the fixed
Mole palette:

| tone | color | used for |
| --- | --- | --- |
| success | `#A5D6A7` | meters below 50% |
| warning | `#FFA94D` | 50–79% (and the stale clock) |
| error | `#FF5F5F` | 80% and above / failures |
| accent | `#C79FD7` | `◈ Go usage` title |
| border | `#404040` | frame lines |
| muted | `#737373` | reset countdown, clock, hints |

Set `colorMode: "theme"` to follow the resolved OpenCode theme instead.

The block is framed by the model itself: `◈ Go usage` top-left, the clock of
the last **successful** fetch top-right (stale tone yellow/red while showing
stale values). There is no footer line while data is fresh — a warning line
(`stale · retrying automatically`) appears only when the last refresh failed.
`frame: "none"` restores the plain header layout.

## How it gets the data

- Login uses the **same OAuth device flow as the OpenCode CLI's "OpenCode
  Console account" connection** (client `opencode-cli`): `/go-usage` shows a
  code + URL (`/go-usage-login` does the same), you approve in the browser, and
  tokens are stored in plugin storage with automatic refresh.
- Meters come from `GET https://opencode.ai/console/api/go/status` — the route
  the Console SPA renders from. This is not a documented public API; endpoints
  are isolated in `src/auth.mjs`, and `GO_USAGE_BASE_URL` / the `baseUrl`
  option can point elsewhere if they ever move.
- API keys (`sk-…` in `auth.json`) do **not** work on the Console API; only the
  device-flow session works. The plugin never reads your other credentials.
- Tokens live in OpenCode's per-plugin CLI storage (plain JSON, like every
  other CLI plugin); `/go-usage logout` clears them.

## Commands

| Command / palette            | What it does                                          |
| ---------------------------- | ----------------------------------------------------- |
| `/go-usage`                  | Details dialog — **or starts the login when signed out** |
| `/go-usage-login`            | Start the device login (palette: **Go usage: connect**)|
| `/go-usage-logout`           | Forget the stored Console session (palette: **Go usage: disconnect**) |
| `/go-usage-refresh`          | Fetch immediately (palette: **Go usage: refresh**)     |

The legacy argument form still works: `/go-usage login`, `/go-usage logout`,
`/go-usage refresh`.

The sidebar polls every **5 minutes** by default (300 s, adjustable down to
15 s) and keeps the last known values when a fetch fails — the clock turns
yellow and a warning line (`stale · retrying automatically`) appears.

## Install

Requires OpenCode **V2** (tested on v2.0.32). The plugin is CLI-only, so it is
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
      "options": { "interval": 60 }
    }
  ]
}
```

Then restart OpenCode, open a session (`session.sidebar` must not be `"hide"`),
and run `/go-usage` — when signed out it starts the login directly. The sidebar
block appears above the built-in sidebar entries.

## Options and environment

Options go in the `cli.json` plugin entry; `GO_USAGE_*` environment variables
are fallbacks (options win).

| Option        | Env                     | Default                          | Meaning                        |
| ------------- | ----------------------- | -------------------------------- | ------------------------------ |
| `interval`    | `GO_USAGE_INTERVAL`     | `300` (5 min)                    | Poll seconds (clamped 15–3600) |
| `baseUrl`     | `GO_USAGE_BASE_URL`     | `https://opencode.ai/console`    | Console base URL               |
| `org`         | `GO_USAGE_ORG`          | token org                        | Explicit `x-org-id` override   |
| `frame`       | `GO_USAGE_FRAME`        | `"rounded"`                      | Border: `rounded` / `heavy` / `none` |
| `barStyle`    | `GO_USAGE_BAR_STYLE`    | `"mole"`                         | `mole` (toned `░` track, like sys-status) / `solid` |
| `colorMode`   | `GO_USAGE_COLOR_MODE`   | `"mole"`                         | `mole` (fixed Mole palette, like sys-status) / `theme` |
| `sidebar`     | —                       | `true`                           | `false` hides the sidebar block|
| `placement`   | —                       | `"top"`                          | `"bottom"` appends below built-ins |
| `openBrowser` | `GO_USAGE_NO_OPEN=1`    | `true`                           | Auto-open the login URL        |
| `debug`       | `GO_USAGE_DEBUG=1`      | `false`                          | Log to `go-usage-debug.log`    |

Debug logs: `~/.config/opencode/plugins/go-usage-debug.log` (truncated at
512 KB, off unless enabled).

## States

| Sidebar shows                | Meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `not connected` + hint       | No session yet — run `/go-usage` to connect           |
| `checking usage…`            | Signed in, first fetch in flight                      |
| `no active Go subscription`  | Console account has no Go plan (`go/status` → `null`) |
| `session expired`            | Refresh token rejected — run `/go-usage` to reconnect |
| `fetch failed · HTTP …`      | Network/HTTP error, retries automatically             |
| values + `stale · retrying`  | Refresh failed but previous values are kept           |

Disconnecting (`/go-usage logout`) clears the stored tokens and the cached
payload; an in-flight login is invalidated too, so the session cannot come back
on its own.

## Tests

```sh
cd plugins/go-usage
node test/harness.mjs   # or: bun run test
```

Offline only: bar rendering, percent/badge/tone rules, reset countdown
formatting, payload normalization, sidebar models for every state, smart
command routing (`/go-usage` with no argument), device-flow state machine
(`authorization_pending`, `slow_down` backoff, expiry, cancel, refresh),
401 → refresh → retry, logout guards, install helper patching, and source
hygiene. Must print `ALL TESTS PASSED (N assertions)`.

## Notes

- Unofficial integration with the Console UI's own API. The plugin only reads
  usage; it never subscribes, cancels, or changes billing.
- The device login is the same one the OpenCode CLI itself uses for its
  Console account connection; sessions are independent per client.
