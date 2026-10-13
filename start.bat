@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18 or newer is required: https://nodejs.org & pause & exit /b 1)
start "" http://localhost:4321
node server.js
pause
