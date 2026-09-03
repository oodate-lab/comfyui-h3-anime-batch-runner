@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js LTS first.
  pause
  exit /b 1
)
if exist "%APPDATA%\npm\codex.cmd" set "PATH=%APPDATA%\npm;%PATH%"
if exist "%LOCALAPPDATA%\npm\codex.cmd" set "PATH=%LOCALAPPDATA%\npm;%PATH%"
where codex >nul 2>nul
if errorlevel 1 (
  echo [NOTICE] Codex CLI was not found. Install it with: npm install -g @openai/codex
  echo          Then run "codex" once and sign in with ChatGPT.
)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:3030'"
npm start
pause
