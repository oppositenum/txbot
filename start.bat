@echo off
REM Windows 启动脚本
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 20+ : https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install --omit=dev
)

echo 启动 txbot 管理服务...
node src\server.js
pause
