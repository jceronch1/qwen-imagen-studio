@echo off
cd /d "%~dp0"
rem Opened from PowerShell 7, the inherited module path hides Get-FileHash and Expand-Archive.
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
pause
