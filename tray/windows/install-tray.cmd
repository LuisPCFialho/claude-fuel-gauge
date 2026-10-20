@echo off
rem Fuel Gauge - installs the taskbar icon for this Windows user (double-click).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
