@echo off
chcp 65001 >nul
title Microsoft Rewards Auto
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org/
  pause
  exit /b 1
)
node app\main.js --login
echo.
echo [EXIT] Program stopped. Press any key to close this window.
pause
