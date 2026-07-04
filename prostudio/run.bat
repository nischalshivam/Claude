@echo off
cd /d "%~dp0"
set PATH=%~dp0bin;%PATH%
python gui.py
if errorlevel 1 pause
