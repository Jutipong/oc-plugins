#!/usr/bin/env node
// Register (or remove) the system-status CLI plugin in the global cli.json.
//
//   node scripts/install.mjs              # add / update this checkout
//   node scripts/install.mjs --dry-run    # print the patched file only
//   node scripts/install.mjs --remove     # remove this checkout
//   node scripts/install.mjs --config <path> --interval <seconds>
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
const intervalFlag = args.indexOf("--interval")
const intervalValue = intervalFlag >= 0 ? Number(args[intervalFlag + 1]) : 2
const interval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 2

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

const result = remove
  ? removeCliPlugin(original, pluginUrl)
  : patchCliConfig(original, pluginUrl, { options: { interval } })

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
  console.log(`Removed system-status from ${configPath}`)
} else {
  console.log(`Registered system-status in ${configPath}`)
  console.log(`  package: ${pluginUrl}`)
  console.log(`  options: { interval: ${interval} }`)
  console.log(`Backup: ${configPath}.bak`)
  console.log("Restart OpenCode and open a session — the prompt footer shows CPU/RAM.")
}
