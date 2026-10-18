# Send one esp-buddy event line to the ESP32-S3 RLCD buddy screen over USB CDC.
# Usage: esp-buddy-send.ps1 -Event speaking [-Port COM5]
param(
  [Parameter(Mandatory = $true)][string]$Event,
  [string]$Port = $(
    if ($env:ESP_BUDDY_COM) { $env:ESP_BUDDY_COM }
    elseif ($env:BUDY_COM) { $env:BUDY_COM }
    elseif ($env:AVATAR_COM) { $env:AVATAR_COM }
    else { "COM5" }
  )
)
$valid = @("idle","listening","thinking","speaking","happy","excited","success","confused","error","sleeping","working","greeting","wag","curious")
if ($valid -notcontains $Event) { Write-Error "unknown event: $Event"; exit 2 }
$p = New-Object System.IO.Ports.SerialPort($Port, 115200)
$p.NewLine = "`n"
$p.ReadTimeout = 1500
try {
  $p.Open()
  $p.WriteLine("{`"event`":`"$Event`"}")
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($p.IsOpen) { $p.Close() }
}
