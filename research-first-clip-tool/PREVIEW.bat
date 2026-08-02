@echo off
REM ============================================================
REM  PREVIEW.bat — 120-second REAL preview (poora job nahi).
REM  Sirf preview window ke moments ke sources download hote hain.
REM
REM   PREVIEW.bat                 -> pehle 120s
REM   PREVIEW.bat 300             -> 300s se 120s
REM   PREVIEW.bat 300 90          -> 300s se 90s
REM ============================================================
cd /d "%~dp0"
set START=%1
set DUR=%2
if "%START%"=="" set START=0
if "%DUR%"=="" set DUR=120
node src\run.js --job=preview --redo --preview-start=%START% --preview-duration=%DUR% %3 %4 %5
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo Preview ready: jobs\preview\final.mp4  +  quality-report.html
) else (
  echo PREVIEW FAILED with exit code %RC%. jobs\preview\run.log dekho.
)
pause
exit /b %RC%
