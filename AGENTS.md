# Agent rules — oc-plugins (OpenCode plugins by Jutipong)

Monorepo for OpenCode V2 plugins. Plugins: **esp-buddy** — a playful desk buddy
that mirrors OpenCode activity onto an ESP32-S3 RLCD buddy screen (ported from
the ESP32-S3-AI repo's legacy "avatar" plugin v6; the board side lives there) —
**go-usage** — OpenCode Go plan meters in the CLI prompt footer —
**turn-stats** — cache hit, live t/s and turn timer above the CLI prompt — and
**system-status** — CPU load / RAM in the prompt footer.

## Commits — explicit confirmation required

- NEVER commit or push on your own. After finishing code changes, stop and
  report; wait for the user's explicit order before `git commit` / `git push`.
- This rule stays active across the whole session until the user lifts it.

## Repo conventions

- One plugin per folder: `plugins/<name>/`
  - **Server plugin** (`esp-buddy` shape): `index.js` —
    `Plugin.define({ id: "<name>", async setup(ctx) {...} })`,
    `<name>-send.mjs` / `<name>-send.ps1` out-of-process senders,
    `package.json` (`private: true`, `main: "index.js"`),
    `test/harness.mjs` + `test/mock-loader.mjs`.
  - **CLI plugin** (`go-usage` shape): `tui.ts` entry (plus `src/`),
    `package.json` exposing `"./tui"`, `scripts/install.mjs` to register the
    folder in `cli.json`, `test/harness.mjs`.
  - Every plugin has `README.md` (install, env vars, behavior) and its harness
    must print `ALL TESTS PASSED`.
- Env vars are prefixed with the plugin name (`ESP_BUDDY_*`, `GO_USAGE_*`,
  `SYSTEM_STATUS_*`); legacy `BUDY_*` / `AVATAR_*` names are accepted as
  fallbacks where compatibility matters.
- Senders resolve: env override → next to `index.js` → the live config dir
  (`~/.config/opencode/plugins/`). Debug logs go to
  `~/.config/opencode/plugins/<name>-debug.log`, OFF unless `<NAME>_DEBUG=1`,
  rotating at 512 KB.
- Server plugins load in place via the global `plugins` list in
  `opencode.json(c)` (recommended), or `install.ps1` copies files into the live
  config folder. **CLI-only plugins load via `cli.json`** (global only) or
  discovery under `~/.config/opencode/plugins/`; the repo's own `plugins/`
  folder is NOT an OpenCode discovery path.
- Run the plugin's harness after ANY edit: `cd plugins/<name> && bun run test`
  (or `node test/harness.mjs`) — must print `ALL TESTS PASSED`.
- No secrets in git. (WiFi keys etc. live on the board's SD card only.)

## Verified OpenCode 2.0.31 facts (live-tested on this machine, 2026-10-17)

- `ctx.event.subscribe()` **works**: session-scoped `AsyncIterable<V2Event>`
  with `session.execution.started/succeeded/failed/interrupted`,
  `session.text.delta` (**carries the assistant text** in `data.delta`),
  `session.reasoning.delta`, `session.step.*`, `session.retry.scheduled`,
  `session.idle`, `session.tool.*` (plus noisy `*.updated` broadcasts that
  must be ignored). Events carry `location.directory` (filter to
  `ctx.location.directory`).
- `ctx.session.wait({sessionID})` resolves when that session's **whole turn**
  ends (waits past intermediate steps/tool calls; an idle session resolves in
  ~3ms). Fastest "turn done" signal — child sessions are tracked via
  `session.execution.*` so only the last one ends a turn.
- `ctx.session.hook("prompt")` **fires with the user's message**
  (`input.prompt.text`) — best "the human said something" signal.
- `ctx.session.hook("retry")` fires with `{sessionID, agent, model, error}`
  on provider errors/retries (same moments as `session.retry.scheduled`).
- `ctx.tool.hook("execute.after")` payload: `status` is `"completed"` even
  when the command failed — failures show up in
  `input.result.output.exit !== 0` (shell) or a non-completed status.
- `ctx.aisdk.hook("language")` registers but never fires for HTTP providers.
  Do NOT rely on it (kept only as a best-effort wrap for other runtimes).
- `ctx.session.hook("model.request"/"http.response", kind=primary)` fire per
  model call; `http.response` exposes a real `input.response.body`
  (ReadableStream) — the plugin **tees that body** to observe stream chunks
  (fallback "still generating" signal, e.g. if the event stream dies).
- `setup()` runs once per host but hosts do reload it (probe saw 7 setups /
  4 cleanups in minutes across TUI + service + headless runs) — keep cleanup
  complete (timers + hook registrations) and treat duplicate instances as
  normal (they are benign; each has its own state).

### TUI plugin runtime (probed on 2.2.5, 2026-10-31)

- `setup(ctx)` gets `options, location, app, renderer, client, data, attention,
  theme, themeMode, markdown, keymap, storage, ui`.
- `ctx.data.listen(cb)` works and delivers server events as
  `{ details: { id, created, type, data, location? , durable? } }` — **not
  every event carries `location`** (`session.usage.updated` does not); filter
  only when it is present. `ctx.data.on(type, cb)` also registers fine.
- Live event sequence on 2.2.5: `session.execution.started` →
  `session.step.started` → `session.reasoning.started/.delta` →
  `session.text.started/.delta` → `session.text.ended` →
  `session.step.streamed` (no payload) → `session.step.ended` (carries
  `tokens` + `finish`) → `session.usage.updated` (`tokens`, `cost`) →
  `session.execution.succeeded`. `session.idle` did not fire in the TUI probe
  (the execution event ends the turn); listen for both.
- Deltas are batched (~100 ms, 20–90 chars each), so a live speed meter must
  use a window, not per-event gaps.
- **Mid-stream assistant messages have `tokens: undefined`**; real token
  counts appear only at step end (`session.step.ended.tokens`,
  `session.usage.updated`). `ctx.data.session.message.sync/list` is async-heavy;
  do not poll it per delta.
- `ctx.data.session.status(sessionID)` is `"running"` while streaming and
  `"idle"` afterwards.
- The `prompt.footer.status` slot render receives reactive
  `{ sessionID, mode, showDetails }` and **no `width`** — renderers keep
  their own fallback width.

## esp-buddy specifics

- State model: `working` while any tool is in flight; `thinking` while a
  turn/stream is live; `speaking` while assistant text streams (throttled
  600ms); short pulse poses `listening` (prompt received), `happy` (tool turn
  succeeded), `excited` (tool ran >=8s), `confused` (tool failed / retry),
  `greeting` (waking from sleep), plus `wag`/`curious` (derived art) in the
  idle play pool; `idle` is published the moment the turn ends.
  Personality: energy + streak drive an **idle play pulse every 8-12s**
  (wag/curious/happy/excited when energetic, curious/listening/confused when
  not — curated so both derived poses stay frequent), nap (`sleeping`) after
  15 min without human activity, wake on any activity. A 3s "tail grace"
  after a turn end ignores stray SSE deltas; the 25s quiet timer (guarded by
  in-flight tools + a 15s model-active window) is a backstop.
- Heartbeat resends the current state every 30s (+jitter) but ONLY after real
  activity — never yank the board's clock screen on an idle machine.
- Every send retries (node → powershell on Windows, backoff): several hosts can
  share one COM port, collisions are normal. Never hold COM open persistently.
- Port resolution (`resolvePort`, harness-tested): env override → macOS
  `/dev/cu.usbmodem*` auto-detect → `COM5` on Windows. A resolved path that
  does not exist (board unplugged / stale `BUDY_COM`) means **no spawn at all**;
  the port is re-resolved per send so hot-plugging works without a restart.
- The board side (firmware + SD art, 14 pose names) lives in the
  **ESP32-S3-AI** repo (`Waveshare_ESP32_RLCD_integration_Git_V2.ino`,
  README "Buddy protocol"). A pose that is not in both the firmware event
  list and the SD falls back to `idle`. Wire format: newline-delimited JSON
  `{"event":"<name>"}` at 115200 baud.

## system-status specifics (CLI plugin, verified 2026-10-20 on OpenCode 2.1.1)

- **Surface**: prompt footer only — `context.ui.slot({ append: "prompt.footer.status", ... })`
  beside `go-usage`, a plain `<text>` row (no right alignment, no frame) that
  caps itself at `DEFAULT_WIDTH` 40. No commands, no storage, no network
  requests. Entry `tui.ts` → `src/entry.tsx`
  (`Plugin.define({ id: "system-status", setup(ctx) })`).
- **Line**: default `[CPU:37% · RAM:62%]` (19 cells at default width 40);
  `network: true` appends ` · NET:↓1.20M ↑240K` (38 cells). Labels
  `CPU:`/`RAM:`/`NET:` are muted, values use the threshold
  tone (50/80); network shows `↓`/`↑` in bytes/s with `K` as the smallest
  unit (never raw bytes), at most two decimals below 10 (`0.50K`, `3.40K`,
  `1.20M`) and whole numbers from 10 up (`12K`, `340M`), toned by activity
  (green when flowing, muted when idle/unknown) — brackets and ` · `
  separators are faint. Missing values render `—`
  (`NET:↓— ↑—` while the first counter baseline is pending); collector errors
  prefix `! `. Clipping drops the trailing field whole (`NET`, then `RAM`) and
  keeps the brackets balanced. The network field is opt-in: `network: false`
  (the default) removes it. There is
  **no keyboard-language field**: the probe cost a PowerShell spawn (~3 s CPU,
  73 MB) per sample on Windows and was removed on both platforms.
- **Collector** (`src/collector.mjs`, reference-counted): starts on the first
  row subscriber, stops ~5 s after the last one. One self-scheduling pass per
  tick (the next timer starts after the pass ends, so a slow probe never
  stacks): CPU = `os.cpus()` deltas with an EMA (0.35) and a denominator floor
  at the wall-clock window; RAM on macOS = `vm_stat` active + wired + compressed
  / elsewhere `total - freemem`, sampled every `RAM_INTERVAL_MS` (5 s) on both
  platforms and reused in between; network (only when enabled) = default-route
  interface byte-counter deltas every tick (macOS `netstat -ibn` + `route -n get default`
  cached 60 s, Linux `/proc/net/dev` + `/proc/net/route`, Windows `netstat -e`
  — whole IP stack, no per-interface split). A new baseline (start / interface
  switch) reports no rate for one tick. The pass publishes **one** snapshot,
  and `publish()` compares a rounded signature (cpu / ram / net / stale) first,
  so the row redraws at most once per tick and not at all when nothing a user
  can see changed.
  There is **no temperature source** (macOS 26+ removed the `powermetrics smc`
  sampler); the plugin does not spawn sensor helpers.
- **Options/env**: `interval` / `SYSTEM_STATUS_INTERVAL` (2 s, 1–10),
  `network` / `SYSTEM_STATUS_NETWORK` (`false` default; `true`/`1`/`yes`
  enables it and spawns the probe),
  `colorMode` / `SYSTEM_STATUS_COLOR_MODE` (`mole` default / `theme`),
  `debug` / `SYSTEM_STATUS_DEBUG=1`
  (`~/.config/opencode/plugins/system-status-debug.log`, 512 KB truncate).
- **Tests**: `cd plugins/system-status && node test/harness.mjs` (offline, no
  processes; must print `ALL TESTS PASSED`). Covers CPU delta math, `vm_stat`,
  `netstat` / `netstat -e` / `/proc` parsing, rate math, clipping, one publish
  per tick (and none for an unchanged row), the 5 s RAM cadence, lifecycle with
  injected commands, install helper and packaging.

## go-usage specifics (CLI plugin, verified 2026-10-20 on OpenCode 2.1.1)

- **Surface**: prompt footer only — `context.ui.slot({ append: "prompt.footer.status", ... })`.
  Entry `tui.ts` → `src/entry.tsx` (`Plugin.define({ id: "go-usage", ... })`).
  No sidebar/frame/bars.
- **Line**: `[H:92% · W:45% · M:44%]` (H rolling 5 h, W weekly, M monthly).
  Labels are muted, values use the 50/80 threshold tone, brackets and ` · `
  are faint; missing meters render `—`; stale values prefix `! `. Drop order
  when narrow: `M`, then `W`, keeping the brackets balanced. The row caps at
  36 cells. Non-ready states are `Go …` / `Go —` / `Go !`. The session meters
  (cache/t-s/turn time) moved to the **turn-stats** plugin.
- **Data source**: `GET {console}/api/go/status` (base
  `https://opencode.ai/console`, env/option overridable). Response is nullable
  (no subscription): `access.meters.{fiveHour,week,month}` each
  `{resetsAt, limitMicroCents, usedMicroCents}` (micro-cents = 1e8/dollar,
  strings for bigint safety). Integer percent, `>99%` when rounding hits 100
  without exhaustion, `100%` when used >= limit.
- **Auth**: the CLI's OAuth device flow — `POST /console/auth/device/code`
  `{client_id:"opencode-cli", supports_org_scope:true}`, poll
  `POST /console/auth/device/token` handling `authorization_pending` /
  `slow_down` (+5 s), refresh via `grant_type:"refresh_token"`. API keys
  (`sk-…`) get 401 on the console API. `x-org-id` comes from the token or
  `GO_USAGE_ORG`. Tokens live in `plugin.go-usage.*` CLI storage.
- **Commands**: `/go-usage` with no argument is a smart command
  (`resolveCommand(input, phase)`): details when ready, device login when
  `checking`/`disconnected`. Dedicated `/go-usage-login`, `/go-usage-logout`,
  `/go-usage-refresh`; palette group **Go usage**. The login command refuses to
  start a second flow when connected **unless** the phase is `disconnected`;
  the argument form routes through the same `loginCommand()`. Logout clears
  tokens + cached payload and bumps `loginEpoch` / `suppressAdopt` so a pending
  login or stale storage cannot resurrect the session.
- **Options/env**: `interval` / `GO_USAGE_INTERVAL` (300 s, 15–3600),
  `baseUrl` / `GO_USAGE_BASE_URL`, `org` / `GO_USAGE_ORG`, `colorMode` /
  `GO_USAGE_COLOR_MODE` (`mole` / `theme`),
  `openBrowser` / `GO_USAGE_NO_OPEN=1`, `bridge` / `GO_USAGE_BRIDGE` (on;
  `0`/`false`/`off`/`no` hides the desk-box mirror), `bridgeUrl` /
  `GO_USAGE_BRIDGE_URL` (default `http://127.0.0.1:7331/v1/usage`),
  `debug` / `GO_USAGE_DEBUG=1`
  (`~/.config/opencode/plugins/go-usage-debug.log`, 512 KB truncate). The
  payload is cached in storage so the footer renders instantly after restart.
- **Bridge**: after every successful/absent refresh the entry POSTs
  `{hour, week, month}` percentages to the local esp-buddy desk box; failures
  are swallowed, it never delays a fetch, and `bridge: false` removes it.
- **HTTP timeout**: `fetchJson` aborts after 15 s (`DEFAULT_FETCH_TIMEOUT_MS`),
  so a hung request cannot wedge the refresh `inFlight` promise forever.
- **Tests**: `cd plugins/go-usage && node test/harness.mjs` (offline, no
  network; must print `ALL TESTS PASSED`). Covers meter math/tones, line
  clipping, auth flow, fetch timeout, options, packaging.

## turn-stats specifics (CLI plugin, verified 2026-11-18 on OpenCode 2.2.5)

- **Surface**: `context.ui.slot({ append: "session.composer.top", ... })` — one
  line **right-aligned above the input prompt** (not in the prompt footer).
  The slot receives reactive `{ sessionID }` only (**no `width`**); the host
  stacks slot content in a full-width column, so the renderer wraps the line
  in `<box flexDirection="row" justifyContent="flex-end">` and the model keeps
  its own 45-cell cap. Entry `tui.ts` → `src/entry.tsx`
  (`Plugin.define({ id: "turn-stats", ... })`). No commands, no storage, no
  network.
- **Line**: `⏱ 00:45 · ▤ 87% · ⚡103t/s` — `⏱` turn wall-clock (`execution.
  started` → `succeeded/failed/interrupted`; counts up live, freezes muted
  after the end until the next turn; `00:00` before the first turn; `MM:SS`,
  minutes keep counting past 99 so the width never changes), `▤` session cache
  hit (`hit% = floor(read / (read + input))`, writes are misses; green ≥ 80,
  plain 50–79, amber < 50, `▤   —` before the first step), `⚡` live output
  speed (always present, muted `⚡  0t/s` when idle; tiers pink ≥ 200, deep
  green 150–199, green 100–149, amber 60–99, red < 60). No brackets; icons are
  muted and ` · ` faint, every number is padded to a fixed width (`⏱` 6,
  `▤` 4, `⚡` 3) so value changes never shift the row. Drop order when narrow:
  `⚡`, then `▤`, then `⏱`; cap 45 cells. Only the slot's own `sessionID` is
  shown.
- **Event feed**: `src/usage-events.mjs` (`createUsageFeed`) owns the
  `context.data.listen` mapping, filtered to `location.directory` — deltas →
  speed tracker, `step.ended` → cache tracker (`assistantMessageID` dedupes
  replayed durable events), `execution.started` → speed + turn clock,
  `step.started` → speed window only (never resets a running turn),
  `execution.*`/`idle` → end. Publishes dedupe by signature; the turn
  signature is second-granularity (`r|f` + `floor(ms/1000)`), so the clock
  redraws at most once a second. `now` is injectable for deterministic tests.
  Do not move this mapping inline — the harness drives the feed with synthetic
  events.
- **Speed estimate**: deltas carry characters, not tokens (no mid-stream
  counters on 2.2.5), so t/s = chars / factor over a 2 s sliding window
  (minimum span 500 ms, hides after 1.5 s quiet); `tpsFactor` default 3.5
  (Thai text ≈ 2.4), clamped 1–8.
- **Options/env**: `colorMode` / `TURN_STATS_COLOR_MODE` (`mole` default /
  `theme`), `tpsFactor` / `TURN_STATS_TPS_FACTOR`, `debug` /
  `TURN_STATS_DEBUG=1` (`~/.config/opencode/plugins/turn-stats-debug.log`,
  512 KB truncate). Install via `scripts/install.mjs` → global `cli.json`
  (no options written).
- **Tests**: `cd plugins/turn-stats && node test/harness.mjs` (offline; must
  print `ALL TESTS PASSED`). Covers timer math/formats, tps window/freshness,
  cache math/LRU/dedupe, feed mapping (turn start/end, step-start isolation,
  second-granularity publishing, directory filter, publisher failure), line
  segments/tones/padding/drop order, options, install helpers, packaging.
