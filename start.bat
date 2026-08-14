@echo off
setlocal

cd /d "%~dp0"

echo Enabling corepack...
call corepack enable
if errorlevel 1 exit /b %errorlevel%

if not exist "node_modules" (
  echo Installing dependencies...
  call corepack pnpm install
  if errorlevel 1 exit /b %errorlevel%
)

if not defined DEFAULT_REASONING_EFFORT set "DEFAULT_REASONING_EFFORT=medium"
if not defined DEFAULT_RESPONSE_SPEED set "DEFAULT_RESPONSE_SPEED=balanced"
if not defined PORT set "PORT=3000"
if not defined CHATGPT_BACKEND set "CHATGPT_BACKEND=session"

if defined API_KEYS echo API_KEYS detected from existing environment; /v1/* will require one of those keys.
if not defined API_KEYS echo API_KEYS is not set. Open admin and click "授权 ChatGPT" to generate a runtime key.
echo CHATGPT_BACKEND=%CHATGPT_BACKEND%
echo Starting API service at http://localhost:%PORT%
echo Admin setup: http://localhost:%PORT%/admin  ^<-- click "授权 ChatGPT"
echo Health check: http://localhost:%PORT%/healthz
call corepack pnpm start
