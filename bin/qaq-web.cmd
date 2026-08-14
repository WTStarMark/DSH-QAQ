@echo off
setlocal
title QAQ Guard - dsh web
cd /d "%~dp0\.."
echo [qaq] Starting DeepSeek Harness under the QAQ guard...
node --import tsx/esm src\cli.ts dsh web %*
echo.
echo [qaq] Guard exited.
pause
