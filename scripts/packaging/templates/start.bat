@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0start.mjs"
) else (
  node "%~dp0start.mjs"
)
if errorlevel 1 (
  echo Startup failed. Read the error above and INSTALL.md.
  pause
  exit /b 1
)
