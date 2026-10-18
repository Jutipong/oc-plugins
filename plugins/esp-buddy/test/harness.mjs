// Offline state-machine + personality test for plugins/esp-buddy/index.js.
//   cd plugins/esp-buddy/test && node harness.mjs   (or: bun run test)
// Mocks "@opencode/plugin" and node:child_process (every send is recorded),
// runs the plugin clock 100x faster, holds the idle "play" timers so tests
// stay deterministic, and drives the tool / model / stream / event hooks
// like a real host would.
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(path.join(here, "mock-loader.mjs")).href, import.meta.url);

// --- virtual clock: plugin timers AND Date.now() run 100x faster
const SCALE = 100;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setInterval = (fn, ms, ...a) => realSetInterval(fn, Math.max(1, Math.round((ms ?? 0) / SCALE)), ...a);
const realNow = Date.now.bind(Date);
const clockStart = realNow();
let clockOffset = 0; // harness can jump the virtual clock (nap test)
Date.now = () => clockStart + Math.round((realNow() - clockStart) * SCALE) + clockOffset;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms)); // real ms (~100ms plugin time)

// --- the plugin's idle play timer (8000-12000ms -> 80-120ms here) is held;
// tests fire it explicitly so play pulses never disturb other assertions.
const PLAY_LO = 8000, PLAY_HI = 12000; // native ms the plugin asks for (scaled below)
const playTimers = [];
globalThis.setTimeout = (fn, ms, ...a) => {
  const msReal = ms ?? 0;
  if (msReal >= PLAY_LO && msReal <= PLAY_HI) {
    const id = { unref() {}, _fn: fn, _cancelled: false };
    playTimers.push(id);
    return id;
  }
  return realSetTimeout(fn, Math.max(1, Math.round(msReal / SCALE)), ...a);
};
globalThis.clearTimeout = (t) => {
  if (t && typeof t === "object" && "_cancelled" in t) {
    t._cancelled = true;
    return;
  }
  return realClearTimeout(t);
};
const firePlay = () => {
  const list = playTimers.splice(0);
  for (const t of list) if (!t._cancelled) t._fn();
};

// --- deterministic randomness (pulse poses/durations, heartbeat jitter)
let rngValue = 0.999;
Math.random = () => rngValue;

// A path that always exists keeps every send spawning (the mocked execFile
// records it) even on a host with no board attached; /dev/null is only checked
// on non-Windows platforms, so this works on the Windows dev machine too. The
// no-device guard is tested separately.
const TEST_PORT = "/dev/null";
process.env.ESP_BUDDY_COM = TEST_PORT;

const PLUGIN =
  process.env.ESP_BUDDY_PLUGIN_SRC ||
  process.env.BUDY_PLUGIN_SRC ||
  path.join(here, "..", "index.js");

const sends = (globalThis.__sends = []);
const seq = () => sends.map((s) => s.args[s.args.length - 1]);

let failures = 0;
const expectLast = (label, want) => {
  const last = seq().at(-1);
  if (last === want) console.log(`  ok   ${label} (last=${last})`);
  else { failures++; console.log(`  FAIL ${label}: last=${last} want=${want}`); }
};
const expectNo = (label, fromIndex, value) => {
  const seen = seq().slice(fromIndex);
  if (!seen.includes(value)) console.log(`  ok   ${label} (${seen.length} sends, no "${value}")`);
  else { failures++; console.log(`  FAIL ${label}: "${value}" leaked -> ${JSON.stringify(seen)}`); }
};
const expectTrue = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}${detail ? " " + detail : ""}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? " " + detail : ""}`); }
};

const DIR = "C:\\proj";
const OTHER_DIR = "C:\\elsewhere";
const ev = (type, sid, dir = DIR) => ({ type, location: { directory: dir }, data: { sessionID: sid } });
const evText = (sid, dir = DIR) => ({
  type: "session.text.delta",
  location: { directory: dir },
  data: { sessionID: sid, delta: "hello" },
});

// --- fake plugin context
const toolHooks = new Map(), sessionHooks = new Map(), aisdkHooks = new Map();
const evQueue = [], evWaiters = [];
const pushEvent = (e) => {
  const w = evWaiters.shift();
  if (w) w({ value: e, done: false });
  else evQueue.push(e);
};
const eventIterable = {
  [Symbol.asyncIterator]: () => ({
    next: () => (evQueue.length ? Promise.resolve({ value: evQueue.shift(), done: false })
                               : new Promise((res) => evWaiters.push(res))),
  }),
};
const waiters = [];
const resolveWaits = (sid) => {
  for (const w of waiters.splice(0)) {
    if (!sid || w.sessionID === sid) w.resolve();
    else waiters.push(w);
  }
};
const ctx = {
  location: { directory: DIR },
  tool: { hook: async (n, cb) => { toolHooks.set(n, cb); return { dispose() {} }; } },
  session: {
    hook: async (n, cb) => { sessionHooks.set(n, cb); return { dispose() {} }; },
    wait: ({ sessionID }) => new Promise((resolve, reject) => waiters.push({ sessionID, resolve, reject })),
  },
  aisdk: { hook: async (n, cb) => { aisdkHooks.set(n, cb); return { dispose() {} }; } },
  event: { subscribe: () => eventIterable },
};

const mod = await import(pathToFileURL(PLUGIN).href);
const plugin = mod.default;
const resolvePort = mod.resolvePort;
const cleanup = await plugin.setup(ctx);
console.log("setup done; hooks:",
  "tool=" + [...toolHooks.keys()].join(","),
  "session=" + [...sessionHooks.keys()].join(","),
  "aisdk=" + [...aisdkHooks.keys()].join(","));

const endTurnClean = async (sid) => { // helper: a turn without tools -> idle
  pushEvent(ev("session.execution.started", sid));
  pushEvent(ev("session.execution.succeeded", sid));
  await sleep(15);
};

console.log("\nA. long-running tool (~60s) must not go idle");
toolHooks.get("execute.before")({ tool: "shell", id: "t1" });
expectLast("A1 tool start -> working", "working");
const aStart = seq().length;
await sleep(600);
expectNo("A2 no idle while the tool runs", aStart, "idle");
toolHooks.get("execute.after")({ tool: "shell", id: "t1", status: "completed", result: { output: { exit: 0 } } });
expectLast("A3 a 60s tool ends excited", "excited");
await sleep(30);
expectLast("A4 excited reverts -> thinking", "thinking");
await sleep(400);
expectLast("A5 quiet after the tool -> idle", "idle");

console.log("\nB. response body streaming must not go idle");
sessionHooks.get("model.request")({ kind: "primary", sessionID: "sB" });
expectLast("B1 model request from idle -> thinking", "thinking");
const bodyCtrl = {};
const resp = new Response(new ReadableStream({ start(c) { bodyCtrl.c = c; } }), {
  status: 200,
  headers: { "content-type": "text/event-stream" },
});
const httpInput = {
  kind: "primary", sessionID: "sB", agent: "a", model: {},
  request: new Request("https://example.invalid/v1/chat"), response: resp,
};
const bodyBefore = httpInput.response.body;
sessionHooks.get("http.response")(httpInput);
expectTrue("B2 response body was tee-swapped", httpInput.response.body !== bodyBefore);
const keepRead = (async () => {
  try {
    const r = httpInput.response.body.getReader();
    for (;;) { const { done } = await r.read(); if (done) break; }
  } catch {}
})();
const bStart = seq().length;
for (let i = 0; i < 12; i++) {
  bodyCtrl.c.enqueue(new TextEncoder().encode("data: {}\n\n"));
  await sleep(50);
}
expectNo("B3 no idle while streaming", bStart, "idle");

console.log("\nD. stream stalls (false idle) then a new chunk wakes it");
await sleep(500);
expectLast("D1 stalled stream -> idle", "idle");
bodyCtrl.c.enqueue(new TextEncoder().encode("data: {}\n\n"));
await sleep(60);
expectLast("D2 chunk after idle -> thinking", "thinking");

console.log("\nE. stream closes -> idle again");
bodyCtrl.c.close();
await sleep(500);
expectLast("E1 stream closed -> idle", "idle");
await keepRead;

console.log("\nF. non-primary traffic stays invisible");
const fStart = seq().length;
sessionHooks.get("model.request")({ kind: "title", sessionID: "sF" });
sessionHooks.get("http.response")({
  kind: "title", sessionID: "sF", agent: "a", model: {},
  request: new Request("https://example.invalid/v1/chat"), response: new Response("{}"),
});
await sleep(40);
const fSeen = seq().slice(fStart);
expectTrue("F1 title request/response ignored", !fSeen.some((v) => v !== "idle"), JSON.stringify(fSeen));

console.log("\nG. aisdk language wrap still works when a runtime does fire it");
const fakeModel = {
  specificationVersion: "v3", provider: "test", modelId: "t", supportedUrls: {},
  doStream: async () => ({ stream: new ReadableStream({ start() {} }) }),
};
const wrapInput = { model: {}, sdk: {}, options: {}, language: fakeModel };
aisdkHooks.get("language")(wrapInput);
expectTrue("G1 language model wrapped", wrapInput.language !== fakeModel);

console.log("\nH. event stream: execution.started/succeeded end the turn at once");
await endTurnClean("sh");
expectLast("H0 idle before the turn", "idle");
pushEvent(ev("session.execution.started", "s1"));
await sleep(40);
expectLast("H1 execution.started -> thinking", "thinking");
pushEvent(ev("session.execution.succeeded", "s1"));
await sleep(50);
expectLast("H2 execution.succeeded -> idle immediately", "idle");

console.log("\nI. session.wait resolution ends the turn at once");
sessionHooks.get("model.request")({ kind: "primary", sessionID: "s2" });
await sleep(30);
expectTrue("I1 a session.wait is in flight", waiters.some((w) => w.sessionID === "s2"));
resolveWaits("s2");
await sleep(50);
expectLast("I2 wait resolved -> idle immediately", "idle");

console.log("\nJ. child session finishing must not end the parent's turn");
pushEvent(ev("session.execution.started", "sp"));
pushEvent(ev("session.execution.started", "sc"));
await sleep(40);
expectLast("J1 parent+child -> thinking", "thinking");
pushEvent(ev("session.execution.succeeded", "sc"));
await sleep(50);
expectLast("J2 child done -> still thinking", "thinking");
pushEvent(ev("session.execution.succeeded", "sp"));
await sleep(50);
expectLast("J3 parent done -> idle", "idle");

console.log("\nK. a wait that resolves while a tool runs must not end the turn");
sessionHooks.get("model.request")({ kind: "primary", sessionID: "s3" });
toolHooks.get("execute.before")({ tool: "shell", id: "t3" });
await sleep(30);
expectLast("K1 tool running -> working", "working");
resolveWaits("s3");
await sleep(50);
expectLast("K2 wait while tool runs -> still working", "working");
toolHooks.get("execute.after")({ tool: "shell", id: "t3", status: "completed", result: { output: { exit: 0 } } });
await sleep(30);
expectLast("K3 tool ended -> thinking", "thinking");

console.log("\nM. events from another directory are ignored");
const mStart = seq().length;
pushEvent(ev("session.execution.succeeded", "sx", OTHER_DIR));
pushEvent(evText("sx", OTHER_DIR));
await sleep(40);
const mSeen = seq().slice(mStart);
expectTrue("M1 other-directory events ignored", !mSeen.includes("thinking"), JSON.stringify(mSeen));

console.log("\nN. delta events keep the turn busy (no idle)");
const nStart = seq().length;
for (let i = 0; i < 10; i++) {
  pushEvent(ev("session.reasoning.delta", "s3"));
  pushEvent(ev("skill.updated", "s3"));
  await sleep(40);
}
expectNo("N1 deltas keep it busy", nStart, "idle");
expectLast("N2 state unchanged by noise", "thinking");

console.log("\nP. SSE tail right behind the turn end must not wake the buddy");
pushEvent(ev("session.execution.started", "s4"));
await sleep(20);
expectLast("P1 execution.started -> thinking", "thinking");
pushEvent(ev("session.execution.succeeded", "s4"));
pushEvent(evText("s4"));
await sleep(20);
expectLast("P2 tail delta after the turn end -> stays idle", "idle");
pushEvent(ev("session.execution.started", "s5"));
await sleep(20);
expectLast("P3 a real new turn wakes -> thinking", "thinking");
pushEvent(ev("session.execution.succeeded", "s5")); // close the turn (no tools -> idle)
await sleep(20);
expectLast("P4 turn closed -> idle", "idle");

console.log("\nQ. playful: prompt -> listening pulse -> thinking");
await endTurnClean("sq");
expectLast("Q0 idle", "idle");
sessionHooks.get("prompt")({ sessionID: "sq", prompt: { text: "hello" } });
expectLast("Q1 prompt -> listening", "listening");
await sleep(20);
expectLast("Q2 listening reverts -> thinking", "thinking");

console.log("\nR. playful: text deltas -> speaking, reasoning deltas -> thinking");
pushEvent(evText("sq"));
await sleep(5);
expectLast("R1 text delta -> speaking", "speaking");
await sleep(8); // > 600ms plugin-time throttle
pushEvent(ev("session.reasoning.delta", "sq"));
await sleep(5);
expectLast("R2 reasoning delta -> thinking", "thinking");

console.log("\nS. playful: a turn that used tools ends with a happy pulse");
pushEvent(ev("session.execution.started", "ss"));
await sleep(3);
toolHooks.get("execute.before")({ tool: "shell", id: "ts" });
toolHooks.get("execute.after")({ tool: "shell", id: "ts", status: "completed", result: { output: { exit: 0 } } });
await sleep(3);
pushEvent(ev("session.execution.succeeded", "ss"));
await sleep(3);
expectLast("S1 turn with tools -> happy", "happy");
await sleep(25);
expectLast("S2 happy reverts -> idle", "idle");

console.log("\nT. playful: a failing tool shows confused, then recovers");
toolHooks.get("execute.before")({ tool: "shell", id: "tf" });
await sleep(2);
toolHooks.get("execute.after")({ tool: "shell", id: "tf", status: "completed", result: { output: { exit: 3 } } });
await sleep(3);
expectLast("T1 exit 3 -> confused", "confused");
await sleep(20);
expectLast("T2 confused reverts -> thinking", "thinking");

console.log("\nU. playful: a long tool finishes excited");
toolHooks.get("execute.before")({ tool: "shell", id: "tl" });
await sleep(100); // 10s plugin time (TOOL_LONG_MS = 8s)
toolHooks.get("execute.after")({ tool: "shell", id: "tl", status: "completed", result: { output: { exit: 0 } } });
await sleep(3);
expectLast("U1 long tool -> excited", "excited");
await sleep(15);
expectLast("U2 excited reverts -> thinking", "thinking");

console.log("\nV. playful: idle play pulses, not while working, nap after 15 quiet minutes");
await endTurnClean("sv");
expectLast("V0 idle", "idle");
rngValue = 0; // deterministic: first pose in the pool ("wag"), shortest pulse
firePlay();
await sleep(3);
expectLast("V1 play pulse -> wag", "wag");
await sleep(15);
expectLast("V2 play pulse reverts -> idle", "idle");
toolHooks.get("execute.before")({ tool: "shell", id: "tw" });
const vBefore = seq().length;
firePlay();
await sleep(4);
const vSeen = seq().slice(vBefore);
const playPoses = ["wag", "happy", "excited", "curious", "listening", "confused"];
expectTrue("V3 no play pulse while working", !vSeen.some((v) => playPoses.includes(v)), JSON.stringify(vSeen));
toolHooks.get("execute.after")({ tool: "shell", id: "tw", status: "completed", result: { output: { exit: 0 } } });
await sleep(5);
await endTurnClean("sv2");
expectLast("V4 idle again", "idle");
clockOffset += 16 * 60 * 1000; // jump 16 virtual minutes of quiet
firePlay();
await sleep(3);
expectLast("V5 quiet for 16min -> sleeping", "sleeping");
pushEvent(ev("session.execution.started", "sv3"));
await sleep(3);
expectLast("V6 activity wakes -> greeting", "greeting");
await sleep(20);
expectLast("V7 greeting reverts -> thinking", "thinking");

console.log("\nW. serial port resolution + no-device guard");
const fakeReaddir = (list) => () => list;
const macNames = ["cu.Bluetooth-Incoming-Port", "cu.usbmodem14201", "tty.usbmodem14201", "null"];
expectTrue("W1 macOS auto-detect prefers cu.usbmodem*",
  resolvePort({ env: {}, platform: "darwin", readdir: fakeReaddir(macNames) }) === "/dev/cu.usbmodem14201");
expectTrue("W2 macOS without a USB device -> null",
  resolvePort({ env: {}, platform: "darwin", readdir: fakeReaddir(["cu.Bluetooth-Incoming-Port", "cu.debug-console"]) }) === null);
expectTrue("W3 env override beats auto-detect",
  resolvePort({ env: { ESP_BUDDY_COM: "/dev/cu.custom" }, platform: "darwin", readdir: fakeReaddir(macNames), exists: () => true }) === "/dev/cu.custom");
expectTrue("W3b stale override (board unplugged) -> null",
  resolvePort({ env: { BUDY_COM: "/dev/cu.usbmodem1101" }, platform: "darwin", exists: () => false }) === null);
expectTrue("W4 legacy BUDY_COM / AVATAR_COM still work",
  resolvePort({ env: { AVATAR_COM: "COM7" }, platform: "win32" }) === "COM7");
expectTrue("W5 Windows default stays COM5",
  resolvePort({ env: {}, platform: "win32" }) === "COM5");
expectTrue("W6 unsupported platform -> null (no spawn)",
  resolvePort({ env: {}, platform: "linux" }) === null);

// live guard: with the override removed and no board attached, a state change
// must not spawn a child at all.
const savedPort = process.env.ESP_BUDDY_COM;
delete process.env.ESP_BUDDY_COM;
const livePort = resolvePort();
if (livePort) {
  console.log(`  skip W7 (a real serial device is attached: ${livePort})`);
} else {
  const wBefore = sends.length;
  toolHooks.get("execute.before")({ tool: "shell", id: "tw" });
  await sleep(10);
  expectTrue("W7 no device -> no child process spawned",
    sends.length === wBefore, `(${sends.length - wBefore} sends)`);
  process.env.ESP_BUDDY_COM = savedPort || TEST_PORT;
  toolHooks.get("execute.after")({ tool: "shell", id: "tw", status: "completed", result: { output: { exit: 0 } } });
  await sleep(5);
  expectTrue("W8 port restored -> sends resume", sends.length > wBefore);
}
process.env.ESP_BUDDY_COM = savedPort || TEST_PORT;

console.log("\nO. cleanup");
try { if (typeof cleanup === "function") await cleanup(); console.log("  ok   cleanup ran"); }
catch (e) { failures++; console.log("  FAIL cleanup threw:", String((e && e.message) || e)); }

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
