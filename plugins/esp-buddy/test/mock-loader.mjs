// Test-only module loader: replaces node:child_process with a recorder (so the
// plugin's serial sends can be asserted without spawning processes) and mocks
// the bare "@opencode/plugin" import so the harness runs fully offline.
export async function resolve(specifier, context, next) {
  if (specifier === "node:child_process") {
    return { url: "mock:child_process", shortCircuit: true };
  }
  if (specifier === "@opencode/plugin") {
    return { url: "mock:opencode-plugin", shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === "mock:child_process") {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export const execFile = (cmd, args, opts, cb) => {
          (globalThis.__sends ??= []).push({ cmd, args: [...args], at: Date.now() });
          const child = { unref() {}, kill() {} };
          if (typeof cb === "function") queueMicrotask(() => cb(null));
          return child;
        };
      `,
    };
  }
  if (url === "mock:opencode-plugin") {
    return {
      format: "module",
      shortCircuit: true,
      source: "export const Plugin = { define: (def) => def };",
    };
  }
  return next(url, context);
}
