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
$aa = [char]0x00E1; $at = [char]0x00E3; $ii = [char]0x00ED; $cc = [char]0x00E7; $ot = [char]0x00F5
$Words = @{
  en = @{ days = @('Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'); tomorrow = 'tomorrow'; week = 'Week'; stale = 'No data for a week.'; ago = 'ago'; updated = 'updated'; locked = 'LOCKED.'; none = 'Fuel Gauge: no data yet'; error = 'Fuel Gauge: could not read data'; open = 'Open Fuel Gauge'; refresh = 'Refresh now'; quit = 'Quit'; at = 'at'; of = 'of the limit'; settings = 'Settings...'; show = 'Show in the taskbar'; bars = 'Bars'; percent = 'Percentage'; both = 'Bars and percentage (two icons)'; every = 'Refresh every'; minutes = 'min'; alerts = 'Notify above 90%'; save = 'Save'; cancel = 'Cancel' }
  pt = @{ days = @('dom', 'seg', 'ter', 'qua', 'qui', 'sex', "s$($aa)b"); tomorrow = "amanh$at"; week = 'Semana'; stale = "Sem dados h$($aa) uma semana."; ago = "h$($aa)"; updated = 'atualizado'; locked = 'BLOQUEADO.'; none = 'Fuel Gauge: sem dados ainda'; error = 'Fuel Gauge: erro a ler os dados'; open = 'Abrir Fuel Gauge'; refresh = 'Atualizar agora'; quit = 'Sair'; at = 'a'; of = 'do limite'; settings = "Defini$($cc)$($ot)es..."; show = 'Mostrar na barra'; bars = 'Barras'; percent = 'Percentagem'; both = "Barras e percentagem (dois $($ii)cones)"; every = 'Atualizar a cada'; minutes = 'min'; alerts = 'Avisar acima de 90%'; save = 'Guardar'; cancel = 'Cancelar' }
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
$script:lastHandle2 = [IntPtr]::Zero

# Tray settings, kept next to the data file (one set per account).
$SettingsFile = [IO.Path]::ChangeExtension($DataFile, '.tray.json')
$script:cfg = @{ mode = 'bars'; minutes = 2; alerts = $true }
try {
  if (Test-Path $SettingsFile) {
    $saved = Get-Content $SettingsFile -Raw | ConvertFrom-Json
    if ($saved.mode -in @('bars', 'percent', 'both')) { $script:cfg.mode = [string]$saved.mode }
    if ([int]$saved.minutes -ge 1) { $script:cfg.minutes = [int]$saved.minutes }
    if ($null -ne $saved.alerts) { $script:cfg.alerts = [bool]$saved.alerts }
  }
} catch { }
function Save-Settings { try { $script:cfg | ConvertTo-Json | Set-Content -Path $SettingsFile -Encoding UTF8 } catch { } }

# 4x7 pixel digits, crisp at 16 px.
$Glyphs = @{
  '0' = @('0110', '1001', '1001', '1001', '1001', '1001', '0110'); '1' = @('0010', '0110', '0010', '0010', '0010', '0010', '0111')
  '2' = @('0110', '1001', '0001', '0010', '0100', '1000', '1111'); '3' = @('1110', '0001', '0001', '0110', '0001', '0001', '1110')
  '4' = @('0010', '0110', '1010', '1010', '1111', '0010', '0010'); '5' = @('1111', '1000', '1110', '0001', '0001', '1001', '0110')
  '6' = @('0110', '1000', '1000', '1110', '1001', '1001', '0110'); '7' = @('1111', '0001', '0010', '0010', '0100', '0100', '0100')
  '8' = @('0110', '1001', '1001', '0110', '1001', '1001', '0110'); '9' = @('0110', '1001', '1001', '0111', '0001', '0001', '0110')
}

function New-NumbersIcon([double]$a, [double]$b, [bool]$stale) {
  $s = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
  if ($s -lt 16) { $s = 16 }
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = [int][Math]::Max(1, [Math]::Floor($s / 16))
  $row = 0
  foreach ($v in @($a, $b)) {
    $txt = [string][int][Math]::Min(100, [Math]::Round($v))
    $color = if ($stale) { $Colors.stale } else { $Colors[(Get-Level $v)] }
    $brush = New-Object System.Drawing.SolidBrush $color
    $w = $txt.Length * 4 + ($txt.Length - 1)
    $x0 = [int][Math]::Floor(($s / $k - $w) / 2)
    $y0 = 1 + $row * 8
    for ($c = 0; $c -lt $txt.Length; $c++) {
      $glyph = $Glyphs[[string]$txt[$c]]
      for ($y = 0; $y -lt 7; $y++) {
        for ($x = 0; $x -lt 4; $x++) {
          if ($glyph[$y][$x] -eq '1') { $g.FillRectangle($brush, ($x0 + $c * 5 + $x) * $k, ($y0 + $y) * $k, $k, $k) }
        }
      }
    }
    $row++
  }
  $g.Dispose()
  $handle = $bmp.GetHicon()
  $bmp.Dispose()
  return @{ Icon = [System.Drawing.Icon]::FromHandle($handle); Handle = $handle }
}

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
$tray2 = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add('Open Fuel Gauge', $null, { if ($script:url) { Start-Process $script:url } })
$itemRefresh = $menu.Items.Add('Refresh now', $null, { Update-Tray })
$itemSettings = $menu.Items.Add('Settings...', $null, { Show-Settings })
$null = $menu.Items.Add('-')
$itemQuit = $menu.Items.Add('Quit', $null, { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$itemInfo = New-Object System.Windows.Forms.ToolStripMenuItem
$itemInfo.Enabled = $false
$itemNote = New-Object System.Windows.Forms.ToolStripMenuItem
$itemNote.Enabled = $false
$itemCost = New-Object System.Windows.Forms.ToolStripMenuItem
$itemCost.Enabled = $false
$menu.Items.Insert(0, $itemInfo)
$menu.Items.Insert(1, $itemNote)
$menu.Items.Insert(2, $itemCost)
$menu.Items.Insert(3, (New-Object System.Windows.Forms.ToolStripSeparator))
$tray.ContextMenuStrip = $menu
$tray2.ContextMenuStrip = $menu
$tray2.add_DoubleClick({ if ($script:url) { Start-Process $script:url } })
$tray.add_DoubleClick({ if ($script:url) { Start-Process $script:url } })
$script:lastLevel = @{}

function Update-Tray {
  $a = 0.0; $b = 0.0; $stale = $true
  $text = (W).none
  $info = 'Fuel Gauge'
  $noteText = ''
  $costLine = ''
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
      $notes = @()
      if ($five -and $five.note) { $notes += "5h: $($five.note)" }
      if ($week -and $week.note) { $notes += "$((W).week): $($week.note)" }
      $noteText = $notes -join '  |  '
      if ($d.lastCost) { $costLine = [string]$d.lastCost }
      $acct = Get-AccountLabel $d.account
      $when = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$d.updatedAt).LocalDateTime.ToString('dd/MM HH:mm')
      $info = (@($acct, "$((W).updated) $when ($(Format-Age $ageMin))") | Where-Object { $_ }) -join ' - '
      if ($ageMin -gt 30) { $text = "($(Format-Age $ageMin)) $text" } elseif ($acct) { $text = "$acct - $text" }
      if ($stale) { $text = "$((W).stale) $text" }
      if ($d.locked) { $text = "$((W).locked) $text" }
      if (-not $stale) {
        foreach ($pair in @(@('5h', $a), @((W).week, $b))) {
          $lvl = Get-Level $pair[1]
          if ($script:cfg.alerts -and $lvl -eq 'crit' -and $script:lastLevel[$pair[0]] -ne 'crit') {
            $tray.ShowBalloonTip(6000, 'Fuel Gauge', "$($pair[0]) $((W).at) $(Format-Pct $pair[1])% $((W).of)", [System.Windows.Forms.ToolTipIcon]::Warning)
          }
          $script:lastLevel[$pair[0]] = $lvl
        }
      }
    }
  } catch { $text = (W).error }
  $itemInfo.Text = $info
  $itemNote.Text = $noteText; $itemNote.Visible = [bool]$noteText
  $itemCost.Text = $costLine; $itemCost.Visible = [bool]$costLine
  $itemOpen.Text = (W).open; $itemOpen.Enabled = [bool]$script:url
  $itemRefresh.Text = (W).refresh; $itemQuit.Text = (W).quit; $itemSettings.Text = (W).settings
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $new = if ($script:cfg.mode -eq 'percent') { New-NumbersIcon $a $b $stale } else { New-BarsIcon $a $b $stale }
  $tray.Icon = $new.Icon
  if ($script:cfg.mode -eq 'both') {
    $n2 = New-NumbersIcon $a $b $stale
    $tray2.Icon = $n2.Icon
    $tray2.Text = $text
    $tray2.Visible = $true
    if ($script:lastHandle2 -ne [IntPtr]::Zero) { [void][FuelGauge.Native]::DestroyIcon($script:lastHandle2) }
    $script:lastHandle2 = $n2.Handle
  } else {
    $tray2.Visible = $false
  }
  $tray.Text = $text
  if ($script:lastHandle -ne [IntPtr]::Zero) { [void][FuelGauge.Native]::DestroyIcon($script:lastHandle) }
  $script:lastHandle = $new.Handle
}

function Show-Settings {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Fuel Gauge'
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.ShowInTaskbar = $false
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $f.AutoScaleMode = 'Dpi'
  $f.ClientSize = New-Object System.Drawing.Size(320, 236)
  $grp = New-Object System.Windows.Forms.GroupBox
  $grp.Text = (W).show; $grp.Location = New-Object System.Drawing.Point(12, 10); $grp.Size = New-Object System.Drawing.Size(296, 104)
  $rb = @{}
  $y = 22
  foreach ($m in @('bars', 'percent', 'both')) {
    $r = New-Object System.Windows.Forms.RadioButton
    $r.Text = (W)[$m]; $r.AutoSize = $true; $r.Location = New-Object System.Drawing.Point(14, $y)
    $r.Checked = ($script:cfg.mode -eq $m)
    $grp.Controls.Add($r); $rb[$m] = $r; $y += 26
  }
  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = (W).every; $lbl.AutoSize = $true; $lbl.Location = New-Object System.Drawing.Point(14, 130)
  $cb = New-Object System.Windows.Forms.ComboBox
  $cb.DropDownStyle = 'DropDownList'; $cb.Location = New-Object System.Drawing.Point(150, 126); $cb.Width = 90
  foreach ($n in @(1, 2, 5, 10)) { [void]$cb.Items.Add("$n $((W).minutes)") }
  $cb.SelectedIndex = [Math]::Max(0, [Array]::IndexOf(@(1, 2, 5, 10), [int]$script:cfg.minutes))
  $chk = New-Object System.Windows.Forms.CheckBox
  $chk.Text = (W).alerts; $chk.AutoSize = $true; $chk.Location = New-Object System.Drawing.Point(14, 162); $chk.Checked = [bool]$script:cfg.alerts
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = (W).save; $ok.Location = New-Object System.Drawing.Point(140, 198); $ok.Width = 80; $ok.DialogResult = 'OK'
  $no = New-Object System.Windows.Forms.Button
  $no.Text = (W).cancel; $no.Location = New-Object System.Drawing.Point(228, 198); $no.Width = 80; $no.DialogResult = 'Cancel'
  $f.AcceptButton = $ok; $f.CancelButton = $no
  $f.Controls.AddRange(@($grp, $lbl, $cb, $chk, $ok, $no))
  if ($f.ShowDialog() -eq 'OK') {
    foreach ($m in $rb.Keys) { if ($rb[$m].Checked) { $script:cfg.mode = $m } }
    $script:cfg.minutes = @(1, 2, 5, 10)[$cb.SelectedIndex]
    $script:cfg.alerts = $chk.Checked
    Save-Settings
    $timer.Interval = $script:cfg.minutes * 60000
    Update-Tray
  }
  $f.Dispose()
}

Update-Tray
$tray.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $script:cfg.minutes * 60000
$timer.add_Tick({ Update-Tray })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Stop(); $tray.Dispose(); $mutex.ReleaseMutex()
