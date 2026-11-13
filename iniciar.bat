@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
set PORT=3000
for /f "tokens=2 delims==" %%a in ('findstr /b "PORT=" .env') do set PORT=%%a
start "" http://localhost:%PORT%/remove-bg
node server.js
pause

