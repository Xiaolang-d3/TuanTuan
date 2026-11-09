@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-sharing.ps1"
set "sharing_exit_code=%errorlevel%"
pause
exit /b %sharing_exit_code%
