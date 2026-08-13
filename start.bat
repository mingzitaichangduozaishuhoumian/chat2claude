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
if not defined MOCK_BACKEND_MODELS_JSON set "MOCK_BACKEND_MODELS_JSON=[{""id"":""backend-test-model"",""displayName"":""Backend Test Model""}]"

if defined API_KEYS echo API_KEYS detected from existing environment; /v1/* will require one of those keys.
if not defined API_KEYS echo API_KEYS is not set. Open admin after startup to enable development access.
echo Starting API service at http://localhost:3000
echo Admin setup: http://localhost:3000/admin
echo Health check: http://localhost:3000/healthz
call corepack pnpm start
