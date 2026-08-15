@echo off
setlocal enabledelayedexpansion
title QAQ 一键安装
cd /d "%~dp0\.."

echo ============================================================
echo   QAQ - DeepSeek Harness 启动容灾守卫  一键安装
echo ============================================================

REM --- check node ---
node -v >nul 2>&1
if errorlevel 1 (
  echo.
  echo [错误] 未检测到 Node.js。请先到 https://nodejs.org 安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
echo [1/3] Node.js：ok

REM --- install deps via pnpm (or npm fallback) ---
echo.
echo [2/3] 正在安装依赖（首次需联网，可能耗时 1-3 分钟）...
where pnpm >nul 2>&1
if not errorlevel 1 (
  call pnpm install
  if errorlevel 1 (
    echo [错误] pnpm install 失败，请检查网络或手动执行 pnpm install。
    pause
    exit /b 1
  )
) else (
  echo [提示] 未找到 pnpm，改用 corepack/npx 安装 ...
  call npx -y pnpm@11 install
  if errorlevel 1 (
    echo [错误] 依赖安装失败。请手动执行 pnpm install 后重试。
    pause
    exit /b 1
  )
)

REM --- build the single-file executable ---
echo.
echo [3/3] 正在构建 dist/qaq.mjs ...
call pnpm build
if errorlevel 1 (
  echo [错误] 构建失败。请查看上方错误。
  pause
  exit /b 1
)
if not exist "dist\qaq.mjs" (
  echo [错误] 构建完成但未找到 dist\qaq.mjs，产物可能不完整。
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   安装完成！开始使用：
echo     bin\qaq-web.cmd   双击打开守卫控制台（推荐）
echo     node bin\qaq.mjs console    或从命令行启动控制台
echo   使用前建议执行一次：qaq console 菜单选 [6] 自动挂载备份插件
echo ============================================================
pause
