@echo off
REM ============================================================
REM  START_HERE.bat — ek hi jagah se poora kaam.
REM  Har option ke aage likha hai ki wo KAB karna hai.
REM  Kisi flag ya command line ko yaad rakhne ki zaroorat nahi.
REM ============================================================
cd /d "%~dp0"
:menu
cls
echo ==============================================================
echo   RESEARCH-FIRST CLIP TOOL  -  M3.4
echo ==============================================================
if exist "input\scene-research.json" (echo   pack       : input\scene-research.json  [mila]) else (echo   pack       : NAHI MILA  -^> Genspark ka JSON input\ mein daalo)
if exist "input\voiceover.srt" (echo   voiceover  : input\voiceover.srt  [mila]) else (echo   voiceover  : nahi mila  ^(CHECKPACK phir bhi chalega^))
if exist "output\pack-report.json" (echo   last check : output\pack-report.json) else (echo   last check : abhi tak nahi chalaya)
echo ==============================================================
echo.
echo   1. Setup check              ^(sabse pehle, ek baar^)
echo   2. Pack ka report card      ^(research ke baad HAR baar^)
echo   3. Stage-2 prompt banao     ^(jab pack weak ho^)
echo   4. Stage-2 jawab lagao      ^(Genspark ka JSON aane ke baad^)
echo   5. Preview - shuruat        ^(pehle 120 second^)
echo   6. Preview - beech se       ^(300s se 120 second^)
echo   7. Preview - kamzor hissa   ^(600s se 120 second^)
echo   8. Poora render             ^(teeno preview theek hone ke BAAD^)
echo   9. Shot review kholo        ^(har shot ka frame dekho^)
echo   0. Bahar
echo.
set /p c=  Kya karna hai (0-9)?

if "%c%"=="1" ( node src\run.js --only=check & pause & goto menu )
if "%c%"=="2" ( node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe & echo. & echo Weak hai to option 3 chalao. & pause & goto menu )
if "%c%"=="3" ( node tools\make-stage2.js input\scene-research.json & echo. & echo output\STAGE2_PROMPT.txt Genspark mein paste karo. Jawab stage2.json mein save karke option 4. & pause & goto menu )
if "%c%"=="4" (
  if not exist "stage2.json" ( echo   stage2.json nahi mila - Genspark ka JSON is folder mein "stage2.json" naam se save karo. & pause & goto menu )
  node tools\apply-stage2.js input\scene-research.json stage2.json & echo. & echo Ab option 2 se dobara check karo. & pause & goto menu )
if "%c%"=="5" ( node src\run.js --job=preview_hook --redo --preview-start=0 --preview-duration=120 & call :after preview_hook & goto menu )
if "%c%"=="6" ( node src\run.js --job=preview_mid --redo --preview-start=300 --preview-duration=120 & call :after preview_mid & goto menu )
if "%c%"=="7" ( node src\run.js --job=preview_weak --redo --preview-start=600 --preview-duration=120 & call :after preview_weak & goto menu )
if "%c%"=="8" ( node src\run.js & call :after "" & goto menu )
if "%c%"=="9" (
  if exist "jobs\preview_hook\shot-review.html" ( start "" "jobs\preview_hook\shot-review.html" ) else ( echo   pehle koi preview chalao ^(option 5-7^) )
  pause & goto menu )
if "%c%"=="0" exit /b 0
goto menu

:after
echo.
if "%~1"=="" ( echo   Ho gaya. jobs\ folder mein final.mp4 aur shot-review.html dekho. ) else ( echo   Ho gaya. jobs\%~1\shot-review.html kholo - har shot ka frame wahan hai. )
pause
exit /b 0
