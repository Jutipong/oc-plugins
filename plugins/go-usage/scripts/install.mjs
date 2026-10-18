#!/usr/bin/env node
// Register (or remove) the go-usage CLI plugin in the global cli.json.
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
  sidebarHidden,
} from "./lib.mjs"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const remove = args.includes("--remove")
const configFlag = args.indexOf("--config")
const intervalFlag = args.indexOf("--interval")
const intervalValue = intervalFlag >= 0 ? Number(args[intervalFlag + 1]) : 300
const interval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 300

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
  console.log(`Removed go-usage from ${configPath}`)
} else {
  console.log(`Registered go-usage in ${configPath}`)
  console.log(`  package: ${pluginUrl}`)
  console.log(`  options: { interval: ${interval} }`)
  console.log(`Backup: ${configPath}.bak`)
  const config = JSON.parse(result.text)
  if (sidebarHidden(config)) {
    console.log('Warning: session.sidebar is "hide" — the sidebar widget will not show until it is "auto".')
  }
  console.log("Restart OpenCode, open a session, then run /go-usage login to connect your Console account.")
}
