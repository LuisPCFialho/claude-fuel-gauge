# Installs the Fuel Gauge taskbar icon for the current Windows user.
# - copies fuel-gauge-tray.ps1 to %LOCALAPPDATA%\FuelGauge
# - adds a Startup shortcut (runs hidden at sign-in)
# - starts it now
# Then set the plugin's "trayFile" option to the path printed at the end.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1 [-Name work]
# -Name lets you run one icon per Claude account (e.g. "work" and "personal").

param([string]$Name = '')

$dir = Join-Path $env:LOCALAPPDATA 'FuelGauge'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$script = Join-Path $dir 'fuel-gauge-tray.ps1'
Copy-Item -Force (Join-Path $PSScriptRoot 'fuel-gauge-tray.ps1') $script

$suffix = if ($Name) { "-$Name" } else { '' }
$file = Join-Path $dir "usage$suffix.json"
$arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" -DataFile `"$file`""

$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) "Fuel Gauge$suffix.lnk"
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR 'System32\conhost.exe'
$s.Arguments = $arguments
$s.WorkingDirectory = $dir
$s.Description = 'Fuel Gauge - Claude usage limits in the taskbar'
$s.WindowStyle = 7
$s.Save()

Start-Process -FilePath (Join-Path $env:WINDIR 'System32\conhost.exe') -ArgumentList $arguments -WorkingDirectory $dir

Write-Host ''
Write-Host 'Fuel Gauge tray installed and running.'
Write-Host 'If you do not see it, open the ^ arrow next to the clock and drag the icon to the taskbar.'
Write-Host ''
Write-Host 'Set this as the plugin option "trayFile":'
Write-Host "  $file"
