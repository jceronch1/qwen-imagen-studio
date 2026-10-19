@echo off
cd /d "%~dp0"
rem Installs the engines and the NoobAI-XL SDXL anime model only (about 7 GB, no Qwen-Image).
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -Models anime
pause
