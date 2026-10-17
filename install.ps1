# install.ps1 — copy a plugin from this repo into the live OpenCode plugins
# folder (fallback for environments that do not load plugin folders in place).
#
# Usage:
#   .\install.ps1              # install "budy"
#   .\install.ps1 -Plugin budy
#   .\install.ps1 -List        # list available plugins
param(
  [string]$Plugin = "budy",
  [switch]$List
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginsRoot = Join-Path $root "plugins"

if ($List) {
  Get-ChildItem $pluginsRoot -Directory | Select-Object -ExpandProperty Name
  exit 0
}

$src = Join-Path $pluginsRoot $Plugin
if (-not (Test-Path (Join-Path $src "index.js"))) {
  Write-Error "plugin '$Plugin' not found under $pluginsRoot"
  exit 1
}

$live = Join-Path $env:USERPROFILE ".config\opencode\plugins"
New-Item -ItemType Directory -Force -Path $live | Out-Null

Copy-Item (Join-Path $src "index.js") (Join-Path $live "$Plugin.js") -Force
Get-ChildItem $src -File | Where-Object { $_.Name -like "$Plugin-send.*" } |
  ForEach-Object { Copy-Item $_.FullName $live -Force }

Write-Host "installed '$Plugin' -> $live"
Write-Host "next: restart OpenCode; for the fast sender make sure 'serialport' resolves there"
