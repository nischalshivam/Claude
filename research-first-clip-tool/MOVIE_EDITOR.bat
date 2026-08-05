@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [RUKO] Node nahi mila. Node 18+ install karke dobara MOVIE_EDITOR chalao.
  pause
  exit /b 1
)
node tools\launch-ui.js
if errorlevel 1 (
  echo.
  echo Movie Editor start nahi hua. .runtime\server-7900.log bhej dijiye.
  pause
  exit /b 1
)
exit /b 0
