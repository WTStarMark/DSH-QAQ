@echo off
setlocal
title QAQ Guard - DeepSeek Harness 启动容灾守卫
REM 作者：WTStarMark
cd /d "%~dp0\.."
if not exist "node_modules" (
  echo.
  echo [qaq] 还没安装依赖。请先运行：bin\qaq-install.zh.cmd
  pause
  exit /b 1
)
node --import tsx/esm src\cli.ts console %*
echo.
echo [qaq] 守卫控制台已退出。
pause