@echo off
chcp 65001 >nul
title Microsoft Rewards Auto
cd /d "%~dp0"
set NODE_OPTIONS=--no-warnings
echo ============================================
echo    Microsoft Rewards Auto Check-in
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org/
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core" (
  echo [SETUP] Installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] Failed to install dependencies. Check network and retry.
    pause
    exit /b 1
  )
)
node app\main.js %*
echo.
echo [EXIT] Program stopped. Press any key to close this window.
pause
