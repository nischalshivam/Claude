@echo off
REM ============================================================
REM  START.bat — poori pipeline chalao (ya resume karo)
REM  input\ mein: scene-research.json, voiceover.srt, voiceover.mp3
REM ============================================================
cd /d "%~dp0"
node src\run.js %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo Done. Output: jobs\^<project^>\  -  final.mp4, quality-report.html, NEEDS_SOURCE.csv, run.log, clips\
) else (
  echo FAILED with exit code %RC%.  jobs\^<project^>\run.log dekho.
)
pause
exit /b %RC%
