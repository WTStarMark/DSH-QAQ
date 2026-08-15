@echo off
setlocal
title QAQ Guard - DeepSeek Harness 启动容灾守卫
cd /d "%~dp0\.."
echo ============================================================
echo   QAQ - DeepSeek Harness 启动容灾守卫控制台
echo   (交互式菜单：一键启动 / 查看状态 / 备份 / 回滚 / 日志)
echo ============================================================
if not exist "node_modules" (
  echo.
  echo [qaq] 还没安装依赖。请先运行：bin\qaq-install.cmd
  pause
  exit /b 1
)
node --import tsx/esm src\cli.ts console %*
echo.
echo [qaq] 守卫控制台已退出。
pause
