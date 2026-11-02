@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5+ is required. Download it from https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22.5+ is required. You have:
  node --version
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)

if not exist .env (
  echo Creating .env from .env.example...
  copy .env.example .env >nul
)

echo Starting GhostGate...
echo Dashboard: http://localhost:8080
call node --disable-warning=ExperimentalWarning src/server.js
pause
