@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "data" mkdir "data"
type nul > "data\.booting"
node app\main.js
