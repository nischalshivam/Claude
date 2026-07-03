@echo off
REM One-time setup for Auto Editor (Windows). Mirrors the Footage Collector setup.
cd /d "%~dp0"
echo ============================================
echo  AUTO EDITOR - one-time setup
echo ============================================

python --version >nul 2>&1
if errorlevel 1 (
  echo Python not found. Install Python 3.10+ from python.org first.
  pause
  exit /b 1
)

echo Installing Python packages...
python -m pip install --upgrade pip
python -m pip install Pillow
python -m pip install faster-whisper
if errorlevel 1 (
  echo.
  echo NOTE: faster-whisper failed to install. The tool still works,
  echo it will just use word-count timing instead of Whisper sync.
  echo.
)

if exist bin\ffprobe.exe goto :ffdone
if exist ..\footage_collector\bin\ffprobe.exe (
  echo Reusing ffmpeg from the Footage Collector...
  mkdir bin 2>nul
  copy /y ..\footage_collector\bin\ffmpeg.exe bin\ >nul
  copy /y ..\footage_collector\bin\ffprobe.exe bin\ >nul
  goto :ffdone
)
echo Downloading ffmpeg (this can take a few minutes)...
powershell -NoProfile -Command ^
  "$u='https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';" ^
  "Invoke-WebRequest $u -OutFile ff.zip;" ^
  "Expand-Archive ff.zip -DestinationPath fftmp -Force;" ^
  "New-Item -ItemType Directory -Force bin | Out-Null;" ^
  "Copy-Item fftmp\*\bin\ffmpeg.exe bin\;" ^
  "Copy-Item fftmp\*\bin\ffprobe.exe bin\;" ^
  "Remove-Item ff.zip; Remove-Item fftmp -Recurse -Force"
:ffdone

echo.
echo Setup complete. Start the tool with run.bat
pause
