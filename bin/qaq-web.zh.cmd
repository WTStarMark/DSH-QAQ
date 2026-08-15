@echo off
setlocal
title QAQ Guard - DeepSeek Harness 启动容灾守卫控制台
REM 作者：WTStarMark
cd /d "%~dp0\.."
if not exist "node_modules" (
  echo.
  echo [qaq] 依赖未安装，请先运行 bin\qaq-install.zh.cmd
  pause
  exit /b 1
)
node --import tsx/esm src\cli.ts console --lang zh %*
echo.
echo [qaq] 守卫控制台已退出。
pause
