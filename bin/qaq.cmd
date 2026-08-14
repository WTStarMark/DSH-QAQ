@echo off
setlocal
cd /d "%~dp0\.."
node --import tsx/esm src\cli.ts %*
