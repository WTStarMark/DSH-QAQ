@echo off
setlocal enabledelayedexpansion
title QAQ One-Click Install
REM Author: WTStarMark
cd /d "%~dp0\.."

echo ============================================================
echo   QAQ - DeepSeek Harness Launch Resilience Guard  Installer
echo   Author: WTStarMark
echo ============================================================

REM --- check node ---
node -v >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Install Node.js 22 or later from https://nodejs.org
  pause
  exit /b 1
)
echo [1/3] Node.js: ok

REM --- install deps via pnpm (or npm fallback) ---
echo.
echo [2/3] Installing dependencies (first run needs network, may take 1-3 min)...
where pnpm >nul 2>&1
if not errorlevel 1 (
  call pnpm install
  if errorlevel 1 (
    echo [ERROR] pnpm install failed. Check your network or run pnpm install manually.
    pause
    exit /b 1
  )
) else (
  echo [INFO] pnpm not found, using corepack/npx ...
  call npx -y pnpm@11 install
  if errorlevel 1 (
    echo [ERROR] Dependency install failed. Run pnpm install manually and retry.
    pause
    exit /b 1
  )
)

REM --- build the single-file executable ---
echo.
echo [3/3] Building dist/qaq.mjs ...
call pnpm build
if errorlevel 1 (
  echo [ERROR] Build failed. See the errors above.
  pause
  exit /b 1
)
if not exist "dist\qaq.mjs" (
  echo [ERROR] Build finished but dist\qaq.mjs is missing.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Install complete! Getting started:
echo     bin\qaq-web.cmd       double-click to open the guard console (recommended)
echo     node bin\qaq.mjs console    or start the console from a shell
echo   Suggested first step: qaq console menu item [6] mounts the backup plugin
echo ============================================================
pause
