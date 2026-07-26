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
echo    2.  Attach downloaded subtitles - from a season pack
echo    3.  Make subtitles from audio - when there are none at all
echo    4.  Build the library index
echo    5.  Search for a line         - where is it?
echo    6.  Cut that line to a clip   - WATCH IT. this is the real test
echo    7.  Show what is in the index
echo.
echo    8.  Set the media folder
echo    9.  Run a job queue (jobs.json)
echo    0.  Exit
echo  ----------------------------------------------------------

REM  Say what to do next, so the list is never a guess.
set "NEXT=press 8 and point it at your episode folder"
if defined MEDIA set "NEXT=press 1, then 2, then 4 - in that order"
if defined MEDIA if exist "!DB!" set "NEXT=press 6 and watch a clip - that is the only proof"
echo    NEXT:  !NEXT!
echo.
set "CHOICE="
set /p "CHOICE=  Pick a number: "
if not defined CHOICE goto menu

if "!CHOICE!"=="1" goto do_check
if "!CHOICE!"=="2" goto do_subs
if "!CHOICE!"=="3" goto do_transcribe
if "!CHOICE!"=="4" goto do_build
if "!CHOICE!"=="5" goto do_find
if "!CHOICE!"=="6" goto do_clip
if "!CHOICE!"=="7" goto do_stats
if "!CHOICE!"=="8" goto do_setfolder
if "!CHOICE!"=="9" goto do_queue
if "!CHOICE!"=="0" goto bye
echo.
echo   That was not one of the numbers on the list.
echo.
echo   If a whole path just appeared on the line above, the window was
echo   still waiting on "Press any key" when you pasted - the first
echo   letter answered it and the rest arrived here. Nothing is broken.
echo.
pause
goto menu

REM ------------------------------------------------------------------------
REM  Dragging a folder into the window wraps the path in quotes; typing it
REM  does not. Everything below is stored WITHOUT quotes and quoted again at
REM  the point of use, so a path with spaces survives either way.
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
set "NEWDIR=!NEWDIR:"=!"
if not defined NEWDIR exit /b 0
if not exist "!NEWDIR!\." (
    echo.
    echo   That folder does not exist:  !NEWDIR!
    echo.
    pause
    exit /b 0
)
set "MEDIA=!NEWDIR!"
> "settings.txt" echo media=!MEDIA!
>> "settings.txt" echo db=!DB!
REM  No "press any key" here on purpose. The path is usually pasted, and a
REM  pause straight after a paste swallows the first letter and posts the
REM  rest into the next prompt. The menu header shows the folder anyway.
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

:do_subs
call :need_folder || goto menu
echo.
echo   Where are the downloaded .srt files?
echo   Leave blank if they are already in the media folder.
echo.
set "SUBDIR="
set /p "SUBDIR=  Subtitle folder: "
if defined SUBDIR set "SUBDIR=!SUBDIR:"=!"
echo.
if defined SUBDIR (
    %PY% -m media_index subs "!MEDIA!" --subs "!SUBDIR!"
) else (
    %PY% -m media_index subs "!MEDIA!"
)
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

:do_clip
echo.
echo   This cuts the real clip WITH SOUND and opens it. If you HEAR the
echo   line, the whole chain is right: the subtitle, the timing, the cut.
echo   Seeing the right scene is not enough - a clip can show the right
echo   scene and still sit seconds away from the line.
echo.
set "Q="
set /p "Q=  Type a line of dialogue: "
if not defined Q goto menu
if not exist "proof" mkdir "proof"
set "CLIP=proof\clip.mp4"
echo.
%PY% -m media_index cut "!Q!" --db "!DB!" --out "!CLIP!" --seconds 5 --full-line --audio
if not exist "!CLIP!" goto clip_done
echo.
echo   Opening !CLIP!
start "" "!CLIP!"
:clip_done
echo.
set "HEARD="
set /p "HEARD=  Did you HEAR that line in the clip? [y/N]: "
if /i "!HEARD!"=="y" (
    echo.
    echo   Then this episode is right, end to end.
    echo.
    pause
    goto menu
)
echo.
echo   Then the subtitle for this episode is out by some seconds, and the
echo   next thing needed is the NUMBER. Cutting 40 seconds around the same
echo   line - the tool will say where in those 40 seconds it expected it.
echo.
set "WCLIP=proof\window.mp4"
%PY% -m media_index cut "!Q!" --db "!DB!" --out "!WCLIP!" --window 40
if exist "!WCLIP!" start "" "!WCLIP!"
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
set "JF=!JF:"=!"
if not defined JF set "JF=jobs.json"
if not exist "!JF!" (
    echo.
    echo   Not found: !JF!
    echo.
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
