@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.15 or newer is required. Please install Node.js first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 goto :failed
)
call npm run build
if errorlevel 1 goto :failed
echo.
echo Open http://127.0.0.1:4318 in your browser.
echo Keep this window open. Press Ctrl+C to stop.
call npm start
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo Startup failed. Read the error above.
pause
exit /b 1
