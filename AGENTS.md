# Agent rules — oc-plugins (OpenCode plugins by Jutipong)

Monorepo for OpenCode V2 plugins. Plugins: **esp-buddy** — a playful desk buddy
that mirrors OpenCode activity onto an ESP32-S3 RLCD buddy screen (ported from
the ESP32-S3-AI repo's legacy "avatar" plugin v6; the board side lives there) —
**go-usage** — OpenCode Go plan meters in the CLI prompt footer — and
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
- **Line**: `[CPU:37% · RAM:62% · NET:↓1.20M ↑240K]` (38 cells at default
  width 40). Labels `CPU:`/`RAM:`/`NET:` are muted, values use the threshold
  tone (50/80); network shows `↓`/`↑` in bytes/s with `K` as the smallest
  unit (never raw bytes), at most two decimals below 10 (`0.50K`, `3.40K`,
  `1.20M`) and whole numbers from 10 up (`12K`, `340M`), toned by activity
  (green when flowing, muted when idle/unknown) — brackets and ` · `
  separators are faint. Missing values render `—`
  (`NET:↓— ↑—` while the first counter baseline is pending); collector errors
  prefix `! `. Clipping drops the trailing field whole (`NET`, then `RAM`) and
  keeps the brackets balanced. `network: false` removes the field. There is
  **no keyboard-language field**: the probe cost a PowerShell spawn (~3 s CPU,
  73 MB) per sample on Windows and was removed on both platforms.
- **Collector** (`src/collector.mjs`, reference-counted): starts on the first
  row subscriber, stops ~5 s after the last one. One self-scheduling pass per
  tick (the next timer starts after the pass ends, so a slow probe never
  stacks): CPU = `os.cpus()` deltas with an EMA (0.35) and a denominator floor
  at the wall-clock window; RAM on macOS = `vm_stat` active + wired + compressed
  / elsewhere `total - freemem`, sampled every `RAM_INTERVAL_MS` (5 s) on both
  platforms and reused in between; network = default-route interface
  byte-counter deltas every tick (macOS `netstat -ibn` + `route -n get default`
  cached 60 s, Linux `/proc/net/dev` + `/proc/net/route`, Windows `netstat -e`
  — whole IP stack, no per-interface split). A new baseline (start / interface
  switch) reports no rate for one tick. The pass publishes **one** snapshot,
  and `publish()` compares a rounded signature (cpu / ram / net / stale) first,
  so the row redraws at most once per tick and not at all when nothing a user
  can see changed.
  There is **no temperature source** (macOS 26+ removed the `powermetrics smc`
  sampler); the plugin does not spawn sensor helpers.
- **Options/env**: `interval` / `SYSTEM_STATUS_INTERVAL` (2 s, 1–10),
  `network` / `SYSTEM_STATUS_NETWORK` (`true`; `false`/`0`/`off` hides it and
  skips the subprocess),
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
- **Line**: `[H:92% · W:45% · M:44% · ⚡45 tok/s]` (H rolling 5 h, W weekly,
  M monthly; `⚡n tok/s` is always present on the ready row — `⚡0 tok/s` in
  muted gray when the footer's own session is idle). Labels are muted, values
  use the 50/80 threshold tone, brackets and ` · ` are faint; missing meters
  render `—`; stale values prefix `! `. The speed field is toned by tier:
  green ≥ 100 tok/s (deep green #4CAF50 from 150), amber 60–99, red < 60
  while generating; it is the first field dropped when narrow (then `M`, then
  `W`), keeping the brackets balanced. Non-ready states are `Go …` / `Go —` /
  `Go !` (no speed field).
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
  `GO_USAGE_COLOR_MODE` (`mole` / `theme`), `tps` / `GO_USAGE_TPS` (on;
  `0`/`false`/`off`/`no` hides the speed field), `tpsFactor` /
  `GO_USAGE_TPS_FACTOR` (chars per token, default 3.5, clamped 1–8),
  `openBrowser` / `GO_USAGE_NO_OPEN=1`, `debug` / `GO_USAGE_DEBUG=1`
  (`~/.config/opencode/plugins/go-usage-debug.log`, 512 KB truncate). The
  payload is cached in storage so the footer renders instantly after restart.
- **Speed meter**: the runtime streams `session.text.delta` / `.reasoning.delta`
  but exposes no mid-stream token counters (verified on 2.2.5), so the
  tracker estimates tok/s from delta characters in a 2 s sliding window
  (minimum span 500 ms, hides after 1.5 s without a delta). It listens via
  `context.data.listen`, filters by `location.directory`, ignores child
  sessions, and the slot renders only the rate of its own `sessionID`.
  Publish is throttled to 2/s and skipped when the visible value is
  unchanged.
- **Tests**: `cd plugins/go-usage && node test/harness.mjs` (offline, no
  network; must print `ALL TESTS PASSED`). Covers meter math/tones, the speed
  tracker (window, freshness, per-session isolation, factor clamp), line
  clipping, auth flow, options, packaging.
