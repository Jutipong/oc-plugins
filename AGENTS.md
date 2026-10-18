# Agent rules — oc-plugins (OpenCode plugins by Jutipong)

Monorepo for OpenCode V2 plugins. Plugins: **esp-buddy** — a playful desk buddy
that mirrors OpenCode activity onto an ESP32-S3 RLCD buddy screen (ported from
the ESP32-S3-AI repo's legacy "avatar" plugin v6; the board side lives there) —
and **sys-status** — a native macOS/Windows system dashboard for the CLI
sidebar (no `mo` dependency).

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
  - **CLI plugin** (`sys-status` shape): `tui.ts` entry (plus `src/`),
    `package.json` exposing `"./tui"`, `scripts/install.mjs` to register the
    folder in `cli.json`, `test/harness.mjs`.
  - Every plugin has `README.md` (install, env vars, behavior) and its harness
    must print `ALL TESTS PASSED`.
- Env vars are prefixed with the plugin name (`ESP_BUDDY_*`, `SYS_STATUS_*`);
  legacy `BUDY_*` / `AVATAR_*` names are accepted as fallbacks where
  compatibility matters.
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

## sys-status specifics (CLI plugin, verified 2026-10-18 on OpenCode 2.0.32)

- **No `mo`/Mole dependency.** Native collectors only: `darwin.mjs`
  (`vm_stat`, `df -k /System/Volumes/Data`, `netstat -ib`, `sysctl`,
  `ioreg IOBlockStorageDriver`, `pmset`, `route`, cached `system_profiler`)
  and `win32.mjs` (one long-lived PowerShell process streaming CIM/WMI JSON;
  CPU/memory/uptime from `os`). The harness asserts that no runtime source
  references `MOLE_BIN` / `mo status --watch` / `brew install mole`.
- **CLI-only plugin**: register in `~/.config/opencode/cli.json` via
  `node scripts/install.mjs` (backs up `cli.json`, preserves other entries).
  Windows path: `%USERPROFILE%\.config\opencode\cli.json`. The repo's
  `plugins/` folder is not an OpenCode discovery path; load it explicitly.
- **Entry**: `tui.ts` re-exports `src/entry.tsx`
  (`Plugin.define({ id: "sys-status", setup(ctx) })`). Local CLI plugins do
  not need `node_modules`: OpenCode's runtime plugin support resolves
  `@opencode/plugin/tui`, `solid-js`, `@opentui/*` for the loaded plugin.
- **Two surfaces, one collector** (reference-counted subscribers; starts on
  first mount, stops ~5 s after the last unmount; CPU sampling floors each
  core's denominator at the wall-clock window so parked M-series E-cores read
  idle):
  - **Sidebar** — prepends `sidebar.content` (42-col sidebar, ~37 usable
    columns; keep lines ≤36). Compact framed block: CPU (model + speed) /
    RAM / DSK / PWR / NET with `spacing` = `compact` / `normal` / `airy`.
    `frame` = `rounded` (default) / `heavy` / `none`, drawn by the model
    (`╭─╮│╰╯` / `┏━┓┃┗┛`, tone `border`), top border `◈ System`, **no update
    clock**. Framed content is 32 cells; `frame: "none"` uses 36 and
    prepends a `● <health score>` header line.
  - **Sidebar `sidebarMode: "full"`** — stacks the dashboard cards into the
    sidebar as one column (36 cells, 32 framed): CPU, Memory, Disk, Power,
    Network; no health/identity header, it starts with the CPU card. All
    through the same `frame`/
    `barStyle`/`colorMode`/`cores`. Meters fill the row (label + meter +
    right-aligned value: 19 cells framed / 23 unframed, power 18/22);
    network shows `Up` / `Down` rates as numbers in that right column, no
    sparklines. All
    card titles carry their headline value right-aligned (chip + GHz, memory
    used / total, disk used / total, battery level, network IP; long values
    clipped with `…`). Redundant rows are dropped
    in the sidebar only: disk `Total` and `Used`, memory `Free` and `Total`,
    power `Level` and the network footer (both return when the title value is
    missing).
    `rowSpacing` = `compact` (cards adjacent) / `normal` (blank line) /
    `airy` (faint separator; falls back to `spacing`). Overflowing fields are
    dropped, not mangled (`4P+4E`, battery `· Charged` at 32 cells).
    ~23–27 lines tall; `mode: "full"` is the model option.
- **Health score**: `src/health.mjs` computes the transparent heuristic
  (readme has the penalty table: CPU/memory/disk, battery health + cycles,
  disk I/O, uptime) → `● 97 · Excellent · Restart Recommended` on a healthy
  Mac fixture; shown in the unframed sidebar header.
- **Battery telemetry**: `ioreg -rc AppleSmartBattery` prints discharging
  power/current as unsigned 64-bit (`2^64 + x`: `BatteryPower=18446744073709540941`
  is −10.675 W); `parseIoregBattery` folds it back to signed with BigInt and
  drops implausible magnitudes (watts > 500 / amps > 50 / volts > 100). On
  battery power the `Input` row hides and cycles move to a `Cycles` row when
  no adapter is attached.
- **Bars and colors**: sidebar bars are full-width on their own line below a
  label/value line. `barStyle` = `mole` (default: `█` whole cells + `░` track
  in the same threshold color, CPU/mem/disk/PWR load 50/80, battery level/health
  20/50) or `solid` (filled blocks only). `colorMode` = `mole` (default:
  fixed palette #A5D6A7 / #FFA94D / #FF5F5F / #C79FD7 / #404040 / #737373)
  or `theme` (resolved OpenCode theme). The sidebar `PWR` bar is scaled to
  the adapter's max wattage but shows the actual system draw.
- **Options** (cli.json): `interval` (1–10 s), `sidebar`, `sidebarMode`
  (`compact` default / `full` stacked dashboard), `placement` (top/bottom of
  `sidebar.content`), `spacing` (compact block), `rowSpacing` (full sidebar
  card gaps), `cores` (full sidebar CPU cores: `p` summary / `all`),
  `barStyle`, `frame`, `colorMode`.
- **Bun quirks on this machine**: `os.loadavg()` returns ~0 (use
  `sysctl vm.loadavg`), `fs.statfs` is missing (use `df`), but
  `os.cpus()` times, `os.uptime()`, `os.totalmem()` and `execFile` work.
- **No Processes section** anywhere; the harness asserts the rendered models
  never contain the string `Process`.
- **Tests**: `cd plugins/sys-status && node test/harness.mjs` (must print
  `ALL TESTS PASSED`), live sanitized snapshot via `node
  test/collect-smoke.mjs 8`. Windows parsing is fixture-tested on macOS; live
  Windows verification is manual on a Windows machine.
- Mole (GPL-3.0) is only the visual inspiration; no code is copied and the
  plugin does not require it. Keep the README attribution intact.

## go-usage specifics (CLI plugin, verified 2026-10-18 on OpenCode 2.0.32)

- **Data source**: `GET {console}/api/go/status` (console base
  `https://opencode.ai/console`, env/option overridable). Response is nullable
  (no subscription): `access.meters.{fiveHour,week,month}` each
  `{resetsAt, limitMicroCents, usedMicroCents}` (micro-cents = 1e8/dollar,
  strings for bigint safety). Meter tones match sys-status: tone `>=80 danger`,
  `>=50 warning`, else success; integer percent with `">99% used"` when
  rounding hits 100 without exhaustion; reset countdown
  `ceil(minutes)` → `9d 14h` / `12h 12m` / `0h 31m`.
- **Auth**: the same OAuth device flow the CLI uses for its "OpenCode Console
  account" integration — `POST /console/auth/device/code`
  `{client_id:"opencode-cli", supports_org_scope:true}` (returns `user_code`
  and a relative `/console/device?user_code=…` URI), poll
  `POST /console/auth/device/token` `{grant_type:"urn:ietf:params:oauth:grant-type:device_code",
  device_code, client_id}` handling `authorization_pending` / `slow_down`
  (+5 s), refresh via `grant_type:"refresh_token"`. API keys (`sk-…`) get
  **401** on the console API — a device session is required. `x-org-id` is
  sent from the token (or `GO_USAGE_ORG`); tokens persist in plugin CLI
  storage.
- **Sidebar**: prepends `sidebar.content` (42-col sidebar, 36 usable); the
  frame is **drawn by the model** (not an OpenTUI border box): `frame` =
  `rounded` (default) / `heavy` / `none`, chars `╭─╮│╰╯` / `┏━┓┃┗┛`, tone
  `border` → `theme.border.base`, top border = `◈ Go usage` left + last
  **successful** fetch clock `HH:mm:ss` right (warning color when stale),
  content width 32 (36 − 2 border − 2 padding). Bars match sys-status:
  `barStyle` = `mole` (default: whole `█` cells + `░` track, **both in the
  threshold color**, floor — no partial edge) / `solid` (fill colored, faint
  blank remainder); one label line (`0h 31m · 92%` — countdown first,
  percent last) + one full-width bar line per meter. **No footer when fresh**;
  only a stale warning line
  (`stale · retrying automatically`) appears when the last refresh failed.
  `frame: "none"` falls back to the in-content header with 36-col lines.
- **Colors**: `colorMode` = `mole` (default: sys-status's fixed palette,
  `src/colors.mjs` — #A5D6A7 / #FFA94D / #FF5F5F / #C79FD7 / #404040 / #737373,
  resolved to RGBA via `RGBA.fromInts` in `kit.tsx`) or `theme` (resolved
  OpenCode theme tokens). `base` labels always use `theme.text.base`.
- **Commands**: `/go-usage` with **no argument is a smart command** —
  `resolveCommand(input, phase)` in `src/commands.mjs` (harness-tested) shows
  the details dialog when ready and starts the device login when the phase is
  `checking`/`disconnected`. Dedicated slash commands: `/go-usage-login`,
  `/go-usage-logout`, `/go-usage-refresh` (the legacy `/go-usage
  login|logout|refresh` argument form still works), plus palette entries under
  "Go usage"; `/go-usage-login` toasts instead of re-authenticating when a
  session already exists. Logout clears the tokens and the cached payload, and
  bumps `loginEpoch` / `suppressAdopt` so a pending login or not-yet-cleared
  storage cannot resurrect the session. Polls every 300 s (5 min, clamped
  15–3600 s) and caches the payload in durable storage so the sidebar renders
  instantly after a TUI restart.
- **Env**: `GO_USAGE_INTERVAL`, `GO_USAGE_BASE_URL`, `GO_USAGE_ORG`,
  `GO_USAGE_FRAME`, `GO_USAGE_BAR_STYLE`, `GO_USAGE_COLOR_MODE`,
  `GO_USAGE_NO_OPEN`, `GO_USAGE_DEBUG` (log at
  `~/.config/opencode/plugins/go-usage-debug.log`, 512 KB truncate).
- **Tests**: `cd plugins/go-usage && node test/harness.mjs` (offline, no
  network; must print `ALL TESTS PASSED`). The live first leg was verified
  manually: `device/code` → 200 with `user_code`, `go/status` with a bogus
  token → 401 `{"_tag":"Unauthorized"}`.
