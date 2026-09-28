@echo off
chcp 65001 >nul
title Microsoft Rewards Auto - Run Once
cd /d "%~dp0"
if not exist "data\logs" mkdir "data\logs"
node app\main.js --once > "data\logs\once-output.txt" 2>&1
echo.
echo [DONE] Finished. Full log: data\logs\once-output.txt
pause
