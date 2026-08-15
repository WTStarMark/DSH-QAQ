@echo off
setlocal
title QAQ Guard - DeepSeek Harness Launch Resilience Guard
REM Author: WTStarMark
cd /d "%~dp0\.."
if not exist "node_modules" (
  echo.
  echo [qaq] Dependencies not installed yet. Run bin\qaq-install.cmd first.
  pause
  exit /b 1
)
node --import tsx/esm src\cli.ts console --lang en %*
echo.
echo [qaq] Guard console exited.
pause
