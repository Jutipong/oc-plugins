#!/usr/bin/env node
// Register (or remove) the turn-stats CLI plugin in the global cli.json.
//
//   node scripts/install.mjs              # add / update this checkout
//   node scripts/install.mjs --dry-run    # print the patched file only
//   node scripts/install.mjs --remove     # remove this checkout
//   node scripts/install.mjs --config <path>
//
// Works on macOS and Windows. The plugin is CLI-only, so it belongs in
// cli.json — never in opencode.json(c).

import fs from "node:fs"
import path from "node:path"
import {
  cliConfigPath,
  defaultCliConfig,
  patchCliConfig,
  pluginDirectoryFromModule,
  pluginUrlFor,
  removeCliPlugin,
} from "./lib.mjs"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const remove = args.includes("--remove")
const configFlag = args.indexOf("--config")

const pluginDirectory = pluginDirectoryFromModule(import.meta.url)
const pluginUrl = pluginUrlFor(pluginDirectory)
const configPath = configFlag >= 0 && args[configFlag + 1] ? path.resolve(args[configFlag + 1]) : cliConfigPath()

let original = ""
try {
  original = fs.readFileSync(configPath, "utf8")
} catch (error) {
  if (error?.code !== "ENOENT") throw error
  original = defaultCliConfig()
}

const result = remove ? removeCliPlugin(original, pluginUrl) : patchCliConfig(original, pluginUrl)

if (dryRun) {
  process.stdout.write(result.text)
  process.exit(0)
}

if (!remove && !result.existed) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
}

if (original.trim()) {
  fs.writeFileSync(`${configPath}.bak`, original)
}
fs.writeFileSync(configPath, result.text)

if (remove) {
  console.log(`Removed turn-stats from ${configPath}`)
} else {
  console.log(`Registered turn-stats in ${configPath}`)
  console.log(`  package: ${pluginUrl}`)
  console.log(`Backup: ${configPath}.bak`)
  console.log("Reload OpenCode (/reload) — the line appears right-aligned above the prompt in every session.")
}
