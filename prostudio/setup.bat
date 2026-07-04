@echo off
REM One-time setup for ProStudio (Windows).
cd /d "%~dp0"
echo ============================================
echo  PROSTUDIO - one-time setup
echo ============================================

python --version >nul 2>&1
if errorlevel 1 (
  echo Python not found. Install Python 3.10+ from python.org first.
  pause & exit /b 1
)

echo Installing Python packages...
python -m pip install --upgrade pip
python -m pip install numpy Pillow opencv-python-headless
python -m pip install faster-whisper
if errorlevel 1 echo NOTE: faster-whisper failed; tool falls back to silence-sync (still works).

if exist bin\ffprobe.exe goto :ffdone
if exist ..\footage_collector\bin\ffprobe.exe (
  echo Reusing ffmpeg from the Footage Collector...
  mkdir bin 2>nul
  copy /y ..\footage_collector\bin\ffmpeg.exe bin\ >nul
  copy /y ..\footage_collector\bin\ffprobe.exe bin\ >nul
  goto :ffdone
)
echo Downloading ffmpeg (few minutes)...
powershell -NoProfile -Command ^
  "$u='https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';" ^
  "Invoke-WebRequest $u -OutFile ff.zip;" ^
  "Expand-Archive ff.zip -DestinationPath fftmp -Force;" ^
  "New-Item -ItemType Directory -Force bin | Out-Null;" ^
  "Copy-Item fftmp\*\bin\ffmpeg.exe bin\; Copy-Item fftmp\*\bin\ffprobe.exe bin\;" ^
  "Remove-Item ff.zip; Remove-Item fftmp -Recurse -Force"
:ffdone

echo.
echo Setup complete. Start with run.bat
pause
