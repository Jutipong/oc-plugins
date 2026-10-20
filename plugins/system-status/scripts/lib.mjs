// system-status — install helpers (pure, testable).

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
  const entry = options && Object.keys(options).length > 0 ? { package: pluginUrl, options } : { package: pluginUrl }
  const existed = index >= 0
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

export function defaultCliConfig() {
  return '{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n'
}
