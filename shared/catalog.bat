@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title media_index - Catalog

REM ------------------------------------------------------------------------
REM  Double-click: poori movie/episode ko tag karke ek searchable library
REM  (catalog.json) banata hai. Har shot ko Gemini dekhta hai aur likhta hai
REM  kaun/kya/kaisa shot hai. Ye ek-baar ka kaam hai — har video reuse karega.
REM
REM  Pehli baar 15 minute ka test karo (sasta), phir poori video.
REM ------------------------------------------------------------------------

set "PY="
where python >nul 2>&1
if %errorlevel%==0 set "PY=python"
if not defined PY (
    where py >nul 2>&1
    if !errorlevel!==0 set "PY=py -3"
)
if not defined PY (
    echo.
    echo   Python nahi mila. Pehle setup.bat chalao.
    echo.
    pause
    exit /b 1
)

echo.
echo   ================================================================
echo     Movie / episode ko tag karke library banao
echo   ================================================================
echo.
echo   Video file ka poora path daalo (drag-and-drop bhi kar sakte ho):
set /p "VIDEO=  Video: "
if not defined VIDEO (
    echo   Koi video nahi diya.
    pause
    exit /b 1
)
REM strip surrounding quotes if the path was dragged in
set VIDEO=%VIDEO:"=%

echo.
echo   Sirf pehle kitne MINUTE tag karne hain? (sasta test ke liye 15 likho)
echo   Poori video ke liye khaali chhod ke Enter dabao.
set /p "MINS=  Minutes: "

set "ARGS=catalog "%VIDEO%""
if defined MINS set "ARGS=!ARGS! --minutes !MINS!"

echo.
echo   Chalu ho raha hai... (pehle 'mi gemini' se key check kar lena agar error aaye)
echo.
%PY% -m media_index !ARGS!

echo.
pause
