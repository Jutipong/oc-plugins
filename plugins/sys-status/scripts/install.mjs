#!/usr/bin/env node
// Register (or remove) the sys-status CLI plugin in the global cli.json.
//
//   node scripts/install.mjs              # add / update this checkout
//   node scripts/install.mjs --dry-run    # print the patched file only
//   node scripts/install.mjs --remove     # remove this checkout
//   node scripts/install.mjs --config <path> --interval <seconds>
//
// Option flags (all optional, unknown values are ignored):
//   --interval <1-10>          seconds between samples (default 2)
//   --spacing <compact|normal|airy>
//   --row-spacing <compact|normal|airy>
//   --bar-style <mole|solid>
//   --frame <rounded|heavy|none>
//   --color-mode <mole|theme>
//   --sidebar-mode <compact|full>
//   --cores <p|all>
//   --placement <top|bottom>
//
// Works on macOS and Windows. The plugin is CLI-only, so it belongs in
// cli.json — never in opencode.json(c).

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  cliConfigPath,
  defaultCliConfig,
  parseInstallOptions,
  patchCliConfig,
  pluginDirectoryFromModule,
  pluginUrlFor,
  removeCliPlugin,
  sidebarHidden,
} from "./lib.mjs"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const remove = args.includes("--remove")
const configFlag = args.indexOf("--config")
const intervalFlag = args.indexOf("--interval")
const intervalDefault = intervalFlag >= 0 ? Number(args[intervalFlag + 1]) : 2
const options = parseInstallOptions(args, { defaultInterval: intervalDefault })

const pluginDirectory = pluginDirectoryFromModule(import.meta.url)
const pluginUrl = pluginUrlFor(pluginDirectory)
const configPath = configFlag >= 0 && args[configFlag + 1] ? path.resolve(args[configFlag + 1]) : cliConfigPath()
const baseDir = path.dirname(configPath)

let original = ""
try {
  original = fs.readFileSync(configPath, "utf8")
} catch (error) {
  if (error?.code !== "ENOENT") throw error
  original = defaultCliConfig()
}

const result = remove
  ? removeCliPlugin(original, pluginUrl, { baseDir })
  : patchCliConfig(original, pluginUrl, { options, baseDir })

if (dryRun) {
  process.stdout.write(result.text)
  process.exit(0)
}

if (remove) {
  if (!result.removed) {
    console.log(`sys-status is not registered in ${configPath} — nothing to remove.`)
    process.exit(0)
  }
  if (original.trim()) fs.writeFileSync(`${configPath}.bak`, original)
  fs.writeFileSync(configPath, result.text)
  console.log(`Removed sys-status from ${configPath}`)
  process.exit(0)
}

if (!result.existed) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
}

if (original.trim()) {
  fs.writeFileSync(`${configPath}.bak`, original)
}
fs.writeFileSync(configPath, result.text)

console.log(`Registered sys-status in ${configPath}`)
console.log(`  package: ${pluginUrl}`)
console.log(`  options: ${JSON.stringify(options)}`)
if (original.trim()) console.log(`  backup:  ${configPath}.bak`)
const config = JSON.parse(result.text)
if (sidebarHidden(config)) {
  console.log('Warning: session.sidebar is "hide" — the sidebar widget will not show until it is "auto".')
}
console.log("Restart OpenCode, open a session: sys-status renders in the sidebar.")
