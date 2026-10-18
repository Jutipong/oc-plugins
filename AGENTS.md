# Agent rules — oc-plugins (OpenCode plugins by Jutipong)

Monorepo for OpenCode V2 plugins. First plugin: **esp-buddy** — a playful desk
buddy that mirrors OpenCode activity onto an ESP32-S3 RLCD buddy screen
(ported from the ESP32-S3-AI repo's legacy "avatar" plugin v6; the board side
lives there).

## Commits — explicit confirmation required

- NEVER commit or push on your own. After finishing code changes, stop and
  report; wait for the user's explicit order before `git commit` / `git push`.
- This rule stays active across the whole session until the user lifts it.

## Repo conventions

- One plugin per folder: `plugins/<name>/`
  - `index.js` — `Plugin.define({ id: "<name>", async setup(ctx) {...} })`
  - `<name>-send.mjs` / `<name>-send.ps1` — out-of-process senders (fast / fallback)
  - `package.json` — `private: true`, `main: "index.js"`, runtime deps only
  - `test/harness.mjs` + `test/mock-loader.mjs` — offline state-machine test
  - `README.md` — install, env vars, behavior
- Env vars are prefixed with the plugin name (`ESP_BUDDY_*`); legacy `BUDY_*`
  and `AVATAR_*` names are accepted as fallbacks where compatibility matters.
- Senders resolve: env override → next to `index.js` → the live config dir
  (`~/.config/opencode/plugins/`). Debug logs go to
  `~/.config/opencode/plugins/<name>-debug.log`, OFF unless `<NAME>_DEBUG=1`,
  rotating at 512 KB.
- This repo is the source of truth. Two install modes: the plugin folder is
  loaded in place via the global `plugins` list in `opencode.json(c)`
  (recommended), or `install.ps1` copies `<name>.js` + senders into the live
  config folder.
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
- Every send retries (node → powershell, backoff): several hosts can share
  one COM port, collisions are normal. Never hold COM open persistently.
- The board side (firmware + SD art, 14 pose names) lives in the
  **ESP32-S3-AI** repo (`Waveshare_ESP32_RLCD_integration_Git_V2.ino`,
  README "Buddy protocol"). A pose that is not in both the firmware event
  list and the SD falls back to `idle`. Wire format: newline-delimited JSON
  `{"event":"<name>"}` at 115200 baud.
