@echo off
REM ============================================================
REM  CHECK.bat — setup check (node/ffmpeg/ffprobe/yt-dlp + JS runtime)
REM ============================================================
cd /d "%~dp0"
node src\run.js --only=check
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo Setup incomplete - upar ke [FAIL] dekho.
pause
exit /b %RC%
