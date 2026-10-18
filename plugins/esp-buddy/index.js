import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// esp-buddy — playful OpenCode buddy plugin (OpenCode v2 API). Mirrors CLI
// activity onto the ESP32-S3 RLCD buddy screen as generic {"event":"..."}
// lines over USB CDC. Ported from the legacy "avatar" plugin v6 with a
// naming-layer change only (id / file names / env vars); the state machine is
// identical.
//
// v1 "playful buddy": v6's guarded state machine + a personality layer.
//   working   : a tool is in flight
//   thinking  : turn live / reasoning tokens streaming
//   speaking  : assistant text is streaming (throttled)
//   listening : the human just sent a prompt (short pulse), permission wait
//   happy     : a turn that used tools succeeded (short pulse)
//   excited   : a long tool finished (short pulse)
//   confused  : tool failed / retry / execution failed (short pulse)
//   sleeping  : nobody touched OpenCode for NAP_AFTER_MS (dreamy z's)
//   wag       : tail-wag pose (own art; also used for idle play pulses)
//   curious   : asymmetric-ears pose (own art; idle play pulses)
//   idle      : nothing to do; a *play pulse* fires every ~10s while idle
// Personality: energy + streak drive how often/which playful pose appears;
// pulses always revert (guarded), real states always win over pulses.
//
// Signals (all verified live on 2.0.31 - see AGENTS.md in this repo):
//   ctx.tool.hook("execute.before"/"execute.after")  in-flight tools, results
//   ctx.session.hook("prompt")                       user message (text!)
//   ctx.session.hook("model.request"/"http.request"/"http.response")
//                                                    model call lifecycle +
//                                                    response body tee (chunks)
//   ctx.session.hook("retry")                        provider retry/error
//   ctx.session.wait({sessionID})                    resolves at turn end
//   ctx.event.subscribe()                            session.* events:
//     execution.started/succeeded/failed/interrupted, text.delta (has text!),
//     reasoning.delta, tool.*, retry.scheduled, ... (noisy *.updated ignored)
// - Several opencode hosts can run at once (TUI + agents) and share one COM
//   port, so every send retries with backoff and heartbeats add jitter.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_DIR = path.join(os.homedir(), ".config", "opencode", "plugins");
const firstEnv = (env, ...names) => names.map((n) => env[n]).find(Boolean) || null;
const envOr = (...names) => firstEnv(process.env, ...names);
const firstExisting = (...cands) => cands.find((p) => fs.existsSync(p)) || cands[cands.length - 1];

// senders: env override -> next to this file (repo / copied plugin.js) -> live config dir
const SEND_MJS =
  envOr("ESP_BUDDY_SEND_MJS", "BUDY_SEND_MJS", "AVATAR_SEND_MJS") ||
  firstExisting(path.join(HERE, "esp-buddy-send.mjs"), path.join(LIVE_DIR, "esp-buddy-send.mjs"));
const SEND_PS1 =
  envOr("ESP_BUDDY_SEND_PS1", "BUDY_SEND_PS1", "AVATAR_SEND_PS1") ||
  firstExisting(path.join(HERE, "esp-buddy-send.ps1"), path.join(LIVE_DIR, "esp-buddy-send.ps1"));

// --- serial port --------------------------------------------------------
// Resolution order: env override -> platform default. A host with no board
// attached must not spawn anything: every send used to start a node process,
// fail on a missing COM5 (macOS), retry, and burn CPU for nothing.
const PORT_ENV = ["ESP_BUDDY_COM", "BUDY_COM", "AVATAR_COM"];
const DEFAULT_WIN_PORT = "COM5";
// macOS exposes a USB CDC device (ESP32-S3) as /dev/cu.usbmodem*.
const DARWIN_PORT = /^(?:cu|tty)\.(?:usbmodem|usbserial|SLAB_USBtoUART|wchusbserial)/;

export function resolvePort({
  env = process.env,
  platform = process.platform,
  readdir = fs.readdirSync,
  exists = fs.existsSync,
} = {}) {
  const override = firstEnv(env, ...PORT_ENV);
  if (override) {
    // An unplugged board leaves a stale path (e.g. BUDY_COM=/dev/cu.usbmodem1101)
    // behind: treat it as "no device" instead of spawning for a ghost port.
    if (platform !== "win32" && !exists(override)) return null;
    return override;
  }
  if (platform === "win32") return DEFAULT_WIN_PORT;
  if (platform !== "darwin") return null;
  try {
    const names = readdir("/dev") || [];
    // "cu." sorts before "tty." and "usbmodem" before "usbserial"
    const match = names.filter((name) => DARWIN_PORT.test(name)).sort()[0];
    return match ? `/dev/${match}` : null;
  } catch {
    return null;
  }
}

const LOG = path.join(LIVE_DIR, "esp-buddy-debug.log");
const DEBUG =
  process.env.ESP_BUDDY_DEBUG === "1" ||
  process.env.BUDY_DEBUG === "1" ||
  process.env.AVATAR_DEBUG === "1"; // logging off by default

const QUIET_MS = 25000; // no activity this long -> idle (backstop, checked against busy state)
const RECHECK_MS = 3000; // still busy? re-check instead of going idle
const MODEL_ACTIVE_MS = 15000; // a stream chunk keeps the model "busy" this long
const BUSY_MAX_MS = 10 * 60 * 1000; // safety net: forget tools that never reported done
const TAIL_MS = 3000; // after a turn end, ignore stray SSE/event deltas this long
const SPEAK_THROTTLE_MS = 600; // text/reasoning delta -> speaking/thinking at most this often
const TOOL_LONG_MS = 8000; // a tool running at least this long gets an "excited" blip
const PULSE_MIN_MS = 600; // short poses last 0.6-1.2s
const PULSE_MAX_MS = 1200;
const PLAY_MIN_MS = 8000; // idle play pulse every 8-12s (playful buddy)
const PLAY_MAX_MS = 12000;
const NAP_AFTER_MS = 15 * 60 * 1000; // quiet for this long -> sleeping

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function log(...args) {
  if (!DEBUG) return;
  try {
    try {
      if (fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + ".bak");
    } catch {}
    fs.appendFileSync(LOG, new Date().toISOString() + " " + args.join(" ") + "\n");
  } catch {}
}

function spawnSender(cmd, args, port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    try {
      const child = execFile(
        cmd,
        args,
        { timeout: 5000, windowsHide: true, env: { ...process.env, ESP_BUDDY_COM: port } },
        (err) => finish(!err),
      );
      if (child && child.unref) child.unref();
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish(false);
      }, 2500);
      if (t.unref) t.unref();
    } catch {
      finish(false);
    }
  });
}

let warnedNoPort = false;

async function send(buddy, src) {
  // No board (or no sender) -> never spawn. Re-resolved on every send so a
  // board plugged in later just works; the idle play pulse re-probes every
  // ~10s, the heartbeat every 30s.
  const port = resolvePort();
  if (!port) {
    if (!warnedNoPort) {
      warnedNoPort = true;
      log("no serial port (set " + PORT_ENV[0] + "); sends skipped");
    }
    return;
  }
  if (warnedNoPort) {
    warnedNoPort = false;
    log("serial port available:", port);
  }

  // fast path: node + serialport (~200ms incl. startup); on Windows the
  // powershell sender is the fallback. Other platforms have no fallback.
  const fast = fs.existsSync(SEND_MJS) ? ["node", [SEND_MJS, buddy], port] : null;
  const slow = process.platform === "win32" && fs.existsSync(SEND_PS1)
    ? ["powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SEND_PS1, "-Event", buddy], port]
    : null;
  // attempt order on Windows stays fast, slow, slow
  const plan = [fast, slow, slow].filter(Boolean);
  for (let i = 0; i < plan.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));
    if (await spawnSender(...plan[i])) return;
  }
  log("sender failed after retries:", buddy, "src=" + src, "port=" + port);
}

export default Plugin.define({
  id: "esp-buddy",
  async setup(ctx) {
    log("setup loaded esp-buddy v1 (legacy avatar-v6 core)");
    let current = null; // last buddy state sent
    let idleTimer = null;
    let beat = null;
    let poseTimer = null; // pending "revert" after a short pose
    let poseToken = 0; // invalidates stale reverts
    let playTimer = null; // next idle play pulse
    let lastModelChunk = 0; // last observed stream chunk
    let turnEndedAt = 0; // last turn end (suppresses stream tail noise)
    let lastHumanActivity = Date.now(); // prompt/tool/model/stream activity (nap timer)
    let lastDrainAt = 0; // energy drain bookkeeping
    let lastSpeakAt = 0; // speaking/thinking delta throttle
    let energy = 70; // 0..100, playful drive
    let streak = 0; // successful turns in a row
    let turnHadTools = false;
    let napping = false;
    const running = new Map(); // tool call id -> start time
    const activeExec = new Set(); // session ids with a running turn
    const execGen = new Map(); // session id -> execution counter (stale-wait guard)
    const waits = new Set(); // session ids with a session.wait() in flight

    const modelActive = () => Date.now() - lastModelChunk < MODEL_ACTIVE_MS;

    const toolsBusy = () => {
      if (running.size > 0) {
        const now = Date.now();
        for (const [id, t0] of running) {
          if (now - t0 > BUSY_MAX_MS) {
            log("forget stale tool:", id);
            running.delete(id);
          }
        }
      }
      return running.size > 0;
    };

    const busy = () => toolsBusy() || activeExec.size > 0;

    const armHeartbeat = () => {
      if (beat) return;
      const jitter = Math.floor(Math.random() * 10000);
      beat = setInterval(() => {
        if (current) {
          log("send:", current, "src=heartbeat");
          void send(current, "heartbeat");
        }
      }, 30000 + jitter);
      if (beat.unref) beat.unref();
    };

    // --- low level --------------------------------------------------------
    const sendState = (buddy, src) => {
      current = buddy;
      armHeartbeat();
      log("send:", buddy, "src=" + src);
      void send(buddy, src);
    };

    const cancelPose = () => {
      poseToken++;
      if (poseTimer) clearTimeout(poseTimer);
      poseTimer = null;
    };

    const scheduleIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (current === "idle" || current === "sleeping") return;
      idleTimer = setTimeout(idleCheck, QUIET_MS);
      if (idleTimer.unref) idleTimer.unref();
    };

    // real state change (working/thinking/idle/...): pulses are cancelled
    const publish = (buddy, src) => {
      cancelPose();
      sendState(buddy, src);
      if (buddy !== "sleeping") napping = false;
      scheduleIdle();
    };

    // short playful pose that reverts to `then` unless superseded
    const pulse = (pose, ms, then, src) => {
      cancelPose();
      const token = poseToken;
      sendState(pose, src);
      scheduleIdle();
      poseTimer = setTimeout(() => {
        poseTimer = null;
        if (token !== poseToken) return; // superseded by a real state
        if (current !== pose) return;
        sendState(then, src + ":revert");
      }, ms);
      if (poseTimer.unref) poseTimer.unref();
    };

    const idleCheck = () => {
      idleTimer = null;
      if (busy() || modelActive()) {
        idleTimer = setTimeout(idleCheck, RECHECK_MS);
        if (idleTimer.unref) idleTimer.unref();
        return;
      }
      if (current !== "idle" && current !== "sleeping") publish("idle", "quiet");
    };

    // streaming activity: keeps the turn alive, wakes a false idle
    const stampActivity = (src) => {
      const now = Date.now();
      lastModelChunk = now;
      if (now - lastDrainAt > 30000) {
        lastDrainAt = now;
        energy = Math.max(5, energy - 1); // long work is tiring
      }
      if (current === null || current === "idle" || current === "sleeping") {
        if (now - turnEndedAt < TAIL_MS) return; // stale tail of a finished turn
        publish("thinking", src);
      } else if (current !== "speaking") {
        scheduleIdle();
      }
    };

    // the turn is over: happy when tools did the work, confused when it broke
    const endTurn = (sid, src, ok = true) => {
      if (sid) activeExec.delete(sid);
      if (busy()) return;
      const hadTools = turnHadTools;
      turnHadTools = false;
      lastModelChunk = 0;
      turnEndedAt = Date.now();
      if (ok && hadTools) {
        streak++;
        energy = Math.min(100, energy + 2);
        pulse("happy", rand(1200, 1600), "idle", src);
        return;
      }
      if (!ok) {
        streak = 0;
        pulse("confused", rand(1000, 1400), "idle", src);
        return;
      }
      if (current !== "idle") publish("idle", src);
      napping = false;
    };

    const onRetry = (src) => {
      streak = 0;
      if (busy()) return;
      if (current === "sleeping") return;
      pulse("confused", rand(900, 1300), "thinking", src);
    };

    // --- playful idle behaviour -------------------------------------------
    const maybePlay = () => {
      if (current !== "idle" || busy() || modelActive()) return;
      if (Date.now() - lastHumanActivity > NAP_AFTER_MS) {
        if (!napping) {
          napping = true;
          publish("sleeping", "nap");
        }
        return;
      }
      energy = Math.min(100, energy + 1); // resting is restoring
      const pool = energy > 60
        ? ["wag", "curious", "happy", "excited"]
        : ["curious", "listening", "confused"];
      const pose = pool[rand(0, pool.length - 1)];
      pulse(pose, rand(PULSE_MIN_MS, PULSE_MAX_MS), "idle", "play" + (streak > 2 ? "+streak" : ""));
    };

    const schedulePlay = () => {
      if (playTimer) return;
      playTimer = setTimeout(() => {
        playTimer = null;
        try {
          maybePlay();
        } catch (e) {
          log("play failed:", String((e && e.message) || e));
        }
        schedulePlay();
      }, rand(PLAY_MIN_MS, PLAY_MAX_MS));
      if (playTimer.unref) playTimer.unref();
    };

    // --- hooks ------------------------------------------------------------
    const regs = [];
    const addHook = async (label, promise) => {
      try {
        const reg = await promise;
        if (reg && typeof reg.dispose === "function") regs.push(reg);
        log("hook ok:", label);
      } catch (e) {
        log("hook failed:", label, String((e && e.message) || e));
      }
    };

    // the human said something: perk up before thinking
    await addHook("session.prompt", ctx.session.hook("prompt", (input) => {
      lastHumanActivity = Date.now();
      if (!input || !input.prompt) return;
      if (current === null || current === "idle" || current === "sleeping") {
        pulse("listening", rand(700, 1100), "thinking", "prompt");
      }
    }));

    await addHook("tool.execute.before", ctx.tool.hook("execute.before", (input) => {
      lastHumanActivity = Date.now();
      if (input && input.id != null) running.set(input.id, Date.now());
      turnHadTools = true;
      publish("working", "tool.before");
    }));

    await addHook("tool.execute.after", ctx.tool.hook("execute.after", (input) => {
      lastHumanActivity = Date.now();
      const startedAt = input && input.id != null ? running.get(input.id) : 0;
      const dur = startedAt ? Date.now() - startedAt : 0;
      if (input && input.id != null) running.delete(input.id);
      if (running.size > 0) {
        publish("working", "tool.after");
        return;
      }
      const exit = input && input.result && input.result.output && input.result.output.exit;
      const failed =
        (typeof exit === "number" && exit !== 0) ||
        (input && typeof input.status === "string" && input.status !== "completed");
      if (failed) {
        streak = 0;
        energy = Math.max(5, energy - 2);
        pulse("confused", rand(1000, 1400), "thinking", "tool-fail");
        return;
      }
      energy = Math.max(5, energy - 1);
      if (dur >= TOOL_LONG_MS) {
        pulse("excited", rand(700, 1000), "thinking", "tool-long");
        return;
      }
      publish("thinking", "tool.after");
    }));

    await addHook("session.model.request", ctx.session.hook("model.request", (input) => {
      if (!input || input.kind !== "primary") return;
      lastHumanActivity = Date.now();
      turnEndedAt = 0;
      lastModelChunk = Date.now();
      if (current === null || current === "idle" || current === "sleeping" || current === "listening") {
        publish("thinking", "model.request");
      } else {
        scheduleIdle();
      }
      const sid = input.sessionID;
      if (sid && !waits.has(sid) && typeof ctx.session.wait === "function") {
        waits.add(sid);
        const gen = execGen.get(sid) || 0;
        ctx.session
          .wait({ sessionID: sid })
          .then(() => {
            waits.delete(sid);
            if ((execGen.get(sid) || 0) !== gen) {
              log("stale session.wait resolution ignored");
              return;
            }
            endTurn(sid, "turn-done");
          })
          .catch((e) => {
            waits.delete(sid);
            log("session.wait failed:", String((e && e.message) || e));
          });
      }
    }));

    await addHook("session.retry", ctx.session.hook("retry", () => {
      lastHumanActivity = Date.now();
      onRetry("retry");
    }));

    // response body tap: provider-agnostic "still generating" signal
    const drainStream = (stream) => {
      (async () => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
            lastModelChunk = Date.now();
            if (current === null || current === "idle" || current === "sleeping") {
              if (Date.now() - turnEndedAt < TAIL_MS) continue;
              publish("thinking", "model.stream");
            }
          }
        } catch {}
        finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      })();
    };
    await addHook("session.http.response", ctx.session.hook("http.response", (input) => {
      if (!input || input.kind !== "primary") return;
      lastModelChunk = Date.now();
      scheduleIdle();
      try {
        const body = input.response && input.response.body;
        if (!body || typeof body.tee !== "function") return;
        try {
          Object.defineProperty(input.response, "body", { configurable: true, get: () => undefined });
        } catch (e) {
          log("stream tap skipped (body not swappable)");
          return;
        }
        const [keep, sniff] = body.tee();
        Object.defineProperty(input.response, "body", { configurable: true, get: () => keep });
        drainStream(sniff);
        log("response body tapped (stream watch on)");
      } catch (e) {
        log("stream tap failed:", String((e && e.message) || e));
      }
    }));

    // --- event stream: turn lifecycle, deltas, mood ------------------------
    (async () => {
      let events = 0;
      try {
        const stream = ctx.event.subscribe();
        for await (const ev of stream) {
          const type = ev && ev.type;
          if (typeof type !== "string" || !type.startsWith("session.")) continue;
          const dir = ev.location && ev.location.directory;
          const here = ctx.location && ctx.location.directory;
          if (dir && here && dir !== here) continue;
          const sid = ev.data && ev.data.sessionID;
          events++;
          const now = Date.now();
          switch (type) {
            case "session.execution.started":
              if (sid) {
                activeExec.add(sid);
                execGen.set(sid, (execGen.get(sid) || 0) + 1);
              }
              turnEndedAt = 0; // a fresh turn: stream tails may wake again
              turnHadTools = false;
              lastHumanActivity = now;
              if (current === "sleeping") pulse("greeting", rand(900, 1300), "thinking", "wake");
              else stampActivity("execution.started");
              break;
            case "session.execution.succeeded":
              endTurn(sid, type, true);
              break;
            case "session.execution.failed":
            case "session.execution.interrupted":
              endTurn(sid, type, false);
              break;
            case "session.idle":
              endTurn(sid, type, true);
              break;
            case "session.retry.scheduled":
              onRetry(type);
              break;
            case "session.text.delta": {
              const d = ev.data && ev.data.delta;
              lastHumanActivity = now;
              lastModelChunk = now;
              if (typeof d === "string" && d.trim() && current === "thinking" && now - lastSpeakAt > SPEAK_THROTTLE_MS) {
                lastSpeakAt = now;
                sendState("speaking", "text.delta");
                scheduleIdle();
              }
              break;
            }
            case "session.reasoning.delta":
              lastHumanActivity = now;
              lastModelChunk = now;
              if (current === "speaking" && now - lastSpeakAt > SPEAK_THROTTLE_MS) {
                lastSpeakAt = now;
                sendState("thinking", "reasoning.delta");
                scheduleIdle();
              }
              break;
            case "session.step.streamed":
            case "session.tool.progress":
              lastHumanActivity = now;
              lastModelChunk = now;
              break;
            default:
              break;
          }
        }
        log("event stream ended after", events, "session events");
      } catch (e) {
        log("event stream error:", String((e && e.message) || e));
      }
    })();

    // --- best effort: wrap the provider language model when the runtime
    // exposes one (the aisdk "language" hook does NOT fire for HTTP providers
    // on 2.0.31 - the http.response body tap above is the live signal).
    await addHook("aisdk.language", ctx.aisdk.hook("language", (input) => {
      try {
        const orig = input && input.language;
        if (!orig || typeof orig.doStream !== "function") return;
        input.language = {
          ...orig,
          doStream: async (params) => {
            const res = await orig.doStream(params);
            lastModelChunk = Date.now();
            if (!res || !res.stream || typeof res.stream.pipeThrough !== "function") return res;
            const stream = res.stream.pipeThrough(new TransformStream({
              transform(chunk, ctrl) {
                lastModelChunk = Date.now();
                ctrl.enqueue(chunk);
              },
            }));
            return { ...res, stream };
          },
        };
        log("language model wrapped (doStream)");
      } catch (e) {
        log("language wrap skipped:", String((e && e.message) || e));
      }
    }));

    schedulePlay();
    log("hooks registered:", regs.length, "| esp-buddy ready");

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (poseTimer) clearTimeout(poseTimer);
      if (playTimer) clearTimeout(playTimer);
      if (beat) clearInterval(beat);
      for (const r of regs) {
        try {
          r.dispose();
        } catch {}
      }
    };
  },
});
