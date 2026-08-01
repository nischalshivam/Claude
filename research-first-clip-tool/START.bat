@echo off
REM ============================================================
REM  START.bat — poori pipeline chalao (ya resume karo)
REM  input/ mein ye files honi chahiye:
REM    script.txt, voiceover.mp3, voiceover.srt, scene-research.json
REM ============================================================
cd /d "%~dp0"
node src\run.js %*
echo.
echo Ho gaya. output\ folder dekho (final.mp4, quality-report.html, NEEDS_SOURCE.csv)
pause
