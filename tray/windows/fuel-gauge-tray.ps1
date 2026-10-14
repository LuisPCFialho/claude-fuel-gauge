# Fuel Gauge - Windows taskbar icon with Claude's usage limits.
# Two bars side by side: 5-hour window (left) and week (right). They fill from
# the bottom and change colour with usage. Reads usage.json, which the
# fuel-gauge plugin writes after each response. No API calls, no tokens.
#
# One icon per Claude account: run one copy per file (-DataFile), never point two
# accounts at the same file.

param([string]$DataFile = (Join-Path $env:LOCALAPPDATA 'FuelGauge\usage.json'))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace FuelGauge -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);'

$id = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($DataFile.ToLowerInvariant()))).Replace('-', '').Substring(0, 12)
$mutex = New-Object System.Threading.Mutex($false, "Local\FuelGaugeTray-$id")
if (-not $mutex.WaitOne(0)) { exit }

$IntervalMs = 120000
# Without new readings nothing was used, so the figures stay right; windows
# that pass their reset time drop to 0. Grey only after a full week of silence.
$StaleMinutes = 10080
$aa = [char]0x00E1; $at = [char]0x00E3
$Words = @{
  en = @{ days = @('Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'); tomorrow = 'tomorrow'; week = 'Week'; stale = 'No data for a week.'; ago = 'ago'; updated = 'updated'; locked = 'LOCKED.'; none = 'Fuel Gauge: no data yet'; error = 'Fuel Gauge: could not read data'; open = 'Open Fuel Gauge'; refresh = 'Refresh now'; quit = 'Quit'; at = 'at'; of = 'of the limit' }
  pt = @{ days = @('dom', 'seg', 'ter', 'qua', 'qui', 'sex', "s$($aa)b"); tomorrow = "amanh$at"; week = 'Semana'; stale = 'Sem dados há uma semana.'; ago = 'há'; updated = 'atualizado'; locked = 'BLOQUEADO.'; none = 'Fuel Gauge: sem dados ainda'; error = 'Fuel Gauge: erro a ler os dados'; open = 'Abrir Fuel Gauge'; refresh = 'Atualizar agora'; quit = 'Sair'; at = 'a'; of = 'do limite' }
}
$Colors = @{
  ok    = [System.Drawing.Color]::FromArgb(63, 185, 80)
  warn  = [System.Drawing.Color]::FromArgb(227, 179, 65)
  crit  = [System.Drawing.Color]::FromArgb(248, 81, 73)
  stale = [System.Drawing.Color]::FromArgb(140, 140, 140)
}
$script:lang = 'en'
$script:url = $null

function W { $Words[$script:lang] }
function Get-Level([double]$p) { if ($p -ge 90) { 'crit' } elseif ($p -ge 75) { 'warn' } else { 'ok' } }

function Get-Effective($w) {
  if ($w.resetsAt) {
    $t = [DateTimeOffset]::Parse([string]$w.resetsAt)
    if ($t -le [DateTimeOffset]::UtcNow) { return 0.0 }
  }
  return [double]$w.percent
}

function Format-Reset($iso) {
  if (-not $iso) { return '' }
  $t = [DateTimeOffset]::Parse([string]$iso).LocalDateTime
  $now = Get-Date
  $hh = $t.ToString('HH:mm')
  if ($t.Date -eq $now.Date) { return $hh }
  if ($t.Date -eq $now.Date.AddDays(1)) { return "$((W).tomorrow) $hh" }
  return "$((W).days[[int]$t.DayOfWeek]) $hh"
}

function Format-Pct([double]$p) {
  $s = if ($p -eq [Math]::Floor($p)) { '{0:0}' -f $p } else { ('{0:0.0}' -f $p).Replace(',', '.') }
  if ($script:lang -eq 'pt') { $s.Replace('.', ',') } else { $s }
}

function Format-Age([double]$min) {
  $m = [int][Math]::Round($min)
  $txt = if ($m -lt 60) { "$m min" } elseif ($m -lt 1440) { '{0}h{1:00}' -f [Math]::Floor($m / 60), ($m % 60) } else { '{0}d {1}h' -f [Math]::Floor($m / 1440), [Math]::Floor(($m % 1440) / 60) }
  if ($script:lang -eq 'pt') { "$((W).ago) $txt" } else { "$txt $((W).ago)" }
}

function Get-AccountLabel($email) {
  if (-not $email) { return '' }
  $parts = ([string]$email).Split('@')
  if ($parts.Count -ne 2) { return '' }
  $public = @('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com')
  if ($public -contains $parts[1].ToLowerInvariant()) { return $parts[0] }
  return $parts[1]
}

function Test-LightTaskbar {
  try { return ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).SystemUsesLightTheme -eq 1) } catch { return $false }
}

$script:lastHandle = [IntPtr]::Zero

function New-BarsIcon([double]$a, [double]$b, [bool]$stale) {
  $s = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
  if ($s -lt 16) { $s = 16 }
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  $g.Clear([System.Drawing.Color]::Transparent)
  $light = Test-LightTaskbar
  $outline = if ($light) { [System.Drawing.Color]::FromArgb(150, 40, 40, 40) } else { [System.Drawing.Color]::FromArgb(170, 230, 230, 230) }
  $track = if ($light) { [System.Drawing.Color]::FromArgb(40, 0, 0, 0) } else { [System.Drawing.Color]::FromArgb(55, 255, 255, 255) }
  $gap = [Math]::Max(2, [int][Math]::Round($s / 8))
  $w = [int][Math]::Floor(($s - $gap - 2) / 2)
  $h = $s - 2
  $i = 0
  foreach ($v in @($a, $b)) {
    $x = 1 + $i * ($w + $gap)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $track), $x, 1, $w, $h)
    $color = if ($stale) { $Colors.stale } else { $Colors[(Get-Level $v)] }
    $fill = [int][Math]::Round(($h - 2) * [Math]::Min(100, [Math]::Max(0, $v)) / 100)
    if ($v -gt 0 -and $fill -lt 1) { $fill = 1 }
    if ($fill -gt 0) { $g.FillRectangle((New-Object System.Drawing.SolidBrush $color), $x + 1, 1 + $h - 1 - $fill, $w - 2, $fill) }
    $g.DrawRectangle((New-Object System.Drawing.Pen $outline, 1), $x, 1, $w - 1, $h - 1)
    $i++
  }
  $g.Dispose()
  $handle = $bmp.GetHicon()
  $bmp.Dispose()
  return @{ Icon = [System.Drawing.Icon]::FromHandle($handle); Handle = $handle }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add('Open Fuel Gauge', $null, { if ($script:url) { Start-Process $script:url } })
$itemRefresh = $menu.Items.Add('Refresh now', $null, { Update-Tray })
$null = $menu.Items.Add('-')
$itemQuit = $menu.Items.Add('Quit', $null, { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$itemInfo = New-Object System.Windows.Forms.ToolStripMenuItem
$itemInfo.Enabled = $false
$menu.Items.Insert(0, $itemInfo)
$menu.Items.Insert(1, (New-Object System.Windows.Forms.ToolStripSeparator))
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ if ($script:url) { Start-Process $script:url } })
$script:lastLevel = @{}

function Update-Tray {
  $a = 0.0; $b = 0.0; $stale = $true
  $text = (W).none
  $info = 'Fuel Gauge'
  try {
    if (Test-Path $DataFile) {
      $d = Get-Content $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $script:lang = if ($d.lang -eq 'pt') { 'pt' } else { 'en' }
      $script:url = if ($d.gaugeUrl) { [string]$d.gaugeUrl } else { $null }
      $five = $d.windows | Where-Object { $_.kind -eq 'five_hour' } | Select-Object -First 1
      $week = $d.windows | Where-Object { $_.kind -eq 'seven_day' } | Select-Object -First 1
      if ($five) { $a = Get-Effective $five }
      if ($week) { $b = Get-Effective $week }
      $ageMin = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$d.updatedAt) / 60000
      $stale = $ageMin -gt $StaleMinutes
      $parts = @()
      if ($five) { $parts += "5h $(Format-Pct $a)% ($(Format-Reset $five.resetsAt))" }
      if ($week) { $parts += "$((W).week) $(Format-Pct $b)% ($(Format-Reset $week.resetsAt))" }
      $text = ($parts -join ' | ')
      $acct = Get-AccountLabel $d.account
      $when = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$d.updatedAt).LocalDateTime.ToString('dd/MM HH:mm')
      $info = (@($acct, "$((W).updated) $when ($(Format-Age $ageMin))") | Where-Object { $_ }) -join ' - '
      if ($ageMin -gt 30) { $text = "($(Format-Age $ageMin)) $text" } elseif ($acct) { $text = "$acct - $text" }
      if ($stale) { $text = "$((W).stale) $text" }
      if ($d.locked) { $text = "$((W).locked) $text" }
      if (-not $stale) {
        foreach ($pair in @(@('5h', $a), @((W).week, $b))) {
          $lvl = Get-Level $pair[1]
          if ($lvl -eq 'crit' -and $script:lastLevel[$pair[0]] -ne 'crit') {
            $tray.ShowBalloonTip(6000, 'Fuel Gauge', "$($pair[0]) $((W).at) $(Format-Pct $pair[1])% $((W).of)", [System.Windows.Forms.ToolTipIcon]::Warning)
          }
          $script:lastLevel[$pair[0]] = $lvl
        }
      }
    }
  } catch { $text = (W).error }
  $itemInfo.Text = $info
  $itemOpen.Text = (W).open; $itemOpen.Enabled = [bool]$script:url
  $itemRefresh.Text = (W).refresh; $itemQuit.Text = (W).quit
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $new = New-BarsIcon $a $b $stale
  $tray.Icon = $new.Icon
  $tray.Text = $text
  if ($script:lastHandle -ne [IntPtr]::Zero) { [void][FuelGauge.Native]::DestroyIcon($script:lastHandle) }
  $script:lastHandle = $new.Handle
}

Update-Tray
$tray.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $IntervalMs
$timer.add_Tick({ Update-Tray })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Stop(); $tray.Dispose(); $mutex.ReleaseMutex()
