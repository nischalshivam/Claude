@echo off
REM ============================================================
REM  CHECK.bat — sirf setup check (node/ffmpeg/ffprobe/yt-dlp)
REM ============================================================
cd /d "%~dp0"
node src\run.js --only=check
echo.
pause
