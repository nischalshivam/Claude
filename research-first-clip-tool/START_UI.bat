@echo off
REM ============================================================
REM  START_UI.bat — M5 EDITOR kholta hai (browser apne aap khulega).
REM  Sirf is computer par chalta hai (127.0.0.1) — na internet, na account,
REM  na koi npm install. Node ka apna server hi kaafi hai.
REM
REM  Purana missing-media dashboard ab isi editor ke andar "Missing" tab hai.
REM ============================================================
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo   [RUKO] Node nahi mila. Pehle Node 18+ install karo, phir dobara chalao.
  pause
  exit /b 1
)
node server\app.js
pause
