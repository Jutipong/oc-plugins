// sys-status — install helpers (pure, testable).

import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export function configDirectory(env = process.env, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config")
  return path.join(base, "opencode")
}

export function cliConfigPath(env = process.env, home = os.homedir()) {
  return path.join(configDirectory(env, home), "cli.json")
}

export function pluginDirectoryFromModule(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..")
}

export function pluginUrlFor(directory) {
  return pathToFileURL(directory).href
}

function normalizeSpec(spec, baseDir) {
  if (typeof spec !== "string" || !spec) return null
  if (spec.startsWith("file://")) {
    try {
      return path.resolve(fileURLToPath(spec))
    } catch {
      return spec
    }
  }
  if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)) {
    return path.resolve(baseDir, spec)
  }
  return spec
}

function entrySpec(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return null
}

export function findPluginIndex(plugins, pluginUrl, baseDir) {
  const target = normalizeSpec(pluginUrl, baseDir)
  return plugins.findIndex((entry) => normalizeSpec(entrySpec(entry), baseDir) === target)
}

export function patchCliConfig(text, pluginUrl, { options, baseDir = process.cwd() } = {}) {
  const parsed = text && text.trim() ? JSON.parse(text) : {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cli.json must contain a JSON object")
  }
  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins.slice() : []
  const index = findPluginIndex(plugins, pluginUrl, baseDir)
  const existed = index >= 0
  const existing = existed && plugins[index] && typeof plugins[index] === "object" ? plugins[index].options ?? {} : {}
  const mergedOptions = { ...existing, ...(options ?? {}) }
  const entry =
    Object.keys(mergedOptions).length > 0
      ? { package: pluginUrl, options: mergedOptions }
      : { package: pluginUrl }
  if (existed) plugins[index] = entry
  else plugins.push(entry)
  parsed.plugins = plugins
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, existed, plugins, config: parsed }
}

export function removeCliPlugin(text, pluginUrl, { baseDir = process.cwd() } = {}) {
  const parsed = text && text.trim() ? JSON.parse(text) : {}
  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : []
  const index = findPluginIndex(plugins, pluginUrl, baseDir)
  if (index < 0) return { text, removed: false, config: parsed }
  const next = plugins.slice()
  next.splice(index, 1)
  parsed.plugins = next
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, removed: true, config: parsed }
}

// Every option flag the installer accepts. `kind: "number"` keeps only a
// finite value > 0; `kind: "enum"` keeps only a listed value. Unknown or
// malformed values are ignored so a typo never breaks an existing entry.
const OPTION_FLAGS = [
  { flag: "--interval", key: "interval", kind: "number" },
  { flag: "--spacing", key: "spacing", values: ["compact", "normal", "airy"] },
  { flag: "--row-spacing", key: "rowSpacing", values: ["compact", "normal", "airy"] },
  { flag: "--bar-style", key: "barStyle", values: ["mole", "solid"] },
  { flag: "--frame", key: "frame", values: ["rounded", "heavy", "none"] },
  { flag: "--color-mode", key: "colorMode", values: ["mole", "theme"] },
  { flag: "--sidebar-mode", key: "sidebarMode", values: ["compact", "full"] },
  { flag: "--cores", key: "cores", values: ["p", "all"] },
  { flag: "--placement", key: "placement", values: ["top", "bottom"] },
]

/** Parse `node scripts/install.mjs` flags into the plugin's `options` object. */
export function parseInstallOptions(args = [], { defaultInterval = 2 } = {}) {
  const options = {
    interval: Number.isFinite(defaultInterval) && defaultInterval > 0 ? defaultInterval : 2,
  }
  for (const { flag, key, kind, values } of OPTION_FLAGS) {
    const index = args.indexOf(flag)
    if (index < 0) continue
    const raw = args[index + 1]
    if (kind === "number") {
      const value = Number(raw)
      if (Number.isFinite(value) && value > 0) options[key] = value
    } else if (values.includes(raw)) {
      options[key] = raw
    }
  }
  return options
}

export function defaultCliConfig() {
  return '{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n'
}

export function sidebarHidden(config) {
  return config?.session?.sidebar === "hide"
}
