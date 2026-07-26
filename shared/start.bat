@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title media_index

REM ---------------------------------------------------------------- Python
set "PY="
where python >nul 2>&1
if %errorlevel%==0 set "PY=python"
if not defined PY (
    where py >nul 2>&1
    if !errorlevel!==0 set "PY=py -3"
)
if not defined PY (
    echo.
    echo   Python was not found. Run setup.bat first.
    echo.
    pause
    exit /b 1
)

REM -------------------------------------------- remember the last used paths
set "MEDIA="
set "DB=library.db"
if exist "settings.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("settings.txt") do (
        if /i "%%a"=="media" set "MEDIA=%%b"
        if /i "%%a"=="db" set "DB=%%b"
    )
)

:menu
cls
echo.
echo  ==========================================================
echo    media_index
echo  ==========================================================
echo.
if defined MEDIA (
    echo    media folder : !MEDIA!
) else (
    echo    media folder : (not set yet)
)
echo    index file   : !DB!
echo.
echo  ----------------------------------------------------------
echo    1.  Check a media folder      - is my download usable?
echo    2.  Make subtitles from audio - when a folder has none
echo    3.  Build the library index
echo    4.  Search for a line         - prove it works
echo    5.  Show what is in the index
echo.
echo    6.  Set the media folder
echo    7.  Run a job queue (jobs.json)
echo    0.  Exit
echo  ----------------------------------------------------------
echo.
set "CHOICE="
set /p "CHOICE=  Pick a number: "

if "!CHOICE!"=="1" goto do_check
if "!CHOICE!"=="2" goto do_transcribe
if "!CHOICE!"=="3" goto do_build
if "!CHOICE!"=="4" goto do_find
if "!CHOICE!"=="5" goto do_stats
if "!CHOICE!"=="6" goto do_setfolder
if "!CHOICE!"=="7" goto do_queue
if "!CHOICE!"=="0" goto bye
goto menu

REM ------------------------------------------------------------------------
:need_folder
if defined MEDIA exit /b 0
echo.
echo   No media folder set yet.
call :ask_folder
if not defined MEDIA exit /b 1
exit /b 0

:ask_folder
echo.
echo   Type the folder path, or drag the folder into this window
echo   and press Enter.
echo.
set "NEWDIR="
set /p "NEWDIR=  Folder: "
if not defined NEWDIR exit /b 0
set NEWDIR=!NEWDIR:"=!
if not exist "!NEWDIR!\." (
    echo.
    echo   That folder does not exist:  !NEWDIR!
    pause
    exit /b 0
)
set "MEDIA=!NEWDIR!"
> "settings.txt" echo media=!MEDIA!
>> "settings.txt" echo db=!DB!
exit /b 0

REM ------------------------------------------------------------------------
:do_setfolder
call :ask_folder
goto menu

:do_check
call :need_folder || goto menu
echo.
%PY% -m media_index check "!MEDIA!"
echo.
pause
goto menu

:do_transcribe
call :need_folder || goto menu
echo.
echo   This reads the audio and writes a .srt next to each video.
echo   Roughly 10 minutes per episode. It is safe to stop and restart -
echo   finished files are skipped.
echo.
set "GO="
set /p "GO=  Start? [Y/n]: "
if /i "!GO!"=="n" goto menu
echo.
%PY% -m media_index transcribe "!MEDIA!"
echo.
pause
goto menu

:do_build
call :need_folder || goto menu
echo.
%PY% -m media_index build "!MEDIA!" --db "!DB!" --verify-sync
echo.
pause
goto menu

:do_find
echo.
set "Q="
set /p "Q=  Type a line of dialogue you remember: "
if not defined Q goto menu
echo.
%PY% -m media_index find "!Q!" --db "!DB!"
echo.
pause
goto menu

:do_stats
echo.
%PY% -m media_index stats --db "!DB!"
echo.
pause
goto menu

:do_queue
echo.
set "JF=jobs.json"
set /p "JF=  Job file [jobs.json]: "
if not defined JF set "JF=jobs.json"
set JF=!JF:"=!
if not exist "!JF!" (
    echo.
    echo   Not found: !JF!
    pause
    goto menu
)
echo.
%PY% -m media_index run "!JF!"
echo.
pause
goto menu

:bye
endlocal
exit /b 0
