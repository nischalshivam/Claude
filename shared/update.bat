@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title media_index - update

echo.
echo   Fetching the latest version...
echo.

set "BRANCH=claude/video-clip-relevance-issue-khs33k"
set "ZIPURL=https://github.com/nischalshivam/Claude/archive/refs/heads/%BRANCH%.zip"
set "TMPZIP=%TEMP%\media_index_update.zip"
set "TMPDIR=%TEMP%\media_index_update"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "Invoke-WebRequest -Uri '%ZIPURL%' -OutFile '%TMPZIP%' -UseBasicParsing;" ^
  "if (Test-Path '%TMPDIR%') { Remove-Item -Recurse -Force '%TMPDIR%' };" ^
  "Expand-Archive -Path '%TMPZIP%' -DestinationPath '%TMPDIR%' -Force;" ^
  "$src = Get-ChildItem -Path '%TMPDIR%' -Directory | Select-Object -First 1;" ^
  "$shared = Join-Path $src.FullName 'shared';" ^
  "Copy-Item -Path (Join-Path $shared '*') -Destination '%~dp0' -Recurse -Force;" ^
  "Write-Host '  updated'"

if errorlevel 1 (
    echo.
    echo   Update failed. Check the internet connection, or download the ZIP
    echo   by hand from:
    echo     %ZIPURL%
    echo.
    pause
    exit /b 1
)

del "%TMPZIP%" >nul 2>&1
rmdir /s /q "%TMPDIR%" >nul 2>&1

echo.
echo   Done. Your settings.txt and library.db were left alone.
echo.
pause
