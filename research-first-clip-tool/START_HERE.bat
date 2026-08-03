@echo off
REM ============================================================
REM  START_HERE.bat — ek hi jagah se poora kaam.
REM
REM  ZAROORI: ye ab exit code CHECK karta hai. Pehle render fail hone
REM  par bhi "Ho gaya" likh deta tha — wo jhooth tha aur usse pata hi
REM  nahi chalta tha ki video bani hi nahi.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
:menu
cls
echo ==============================================================
echo   RESEARCH-FIRST CLIP TOOL  -  M3.6
echo ==============================================================
if exist "input\scene-research.json" (echo   pack       : input\scene-research.json  [mila]) else (echo   pack       : NAHI MILA  -^> Genspark ka JSON input\ mein daalo)
if exist "input\voiceover.srt" (echo   voiceover  : input\voiceover.srt  [mila]) else (echo   voiceover  : NAHI MILA  -^> preview/render nahi chalega)
if exist "output\pack-report.json" (echo   pack check : ho chuka  ^(option 2^)) else (echo   pack check : NAHI HUA  -^> option 2 pehle chalao, warna 5-8 block hain)
echo ==============================================================
echo.
echo   1. Setup check              ^(sabse pehle, ek baar^)
echo   2. Pack ka report card      ^(research ke baad HAR baar - ZAROORI^)
echo   3. Stage-2 prompt banao     ^(jab pack weak ho^)
echo   4. Stage-2 jawab lagao      ^(Genspark ka JSON aane ke baad^)
echo   5. Preview - shuruat        ^(pehle 120 second^)
echo   6. Preview - beech se       ^(300s se 120 second^)
echo   7. Preview - kamzor hissa   ^(600s se 120 second^)
echo   8. Poora render             ^(teeno preview theek hone ke BAAD^)
echo   9. Review dashboard         ^(teeno preview ek saath^)
echo   0. Bahar
echo.
set /p c=  Kya karna hai (0-9)?

if "%c%"=="1" ( node src\run.js --only=check & call :done "setup check" & goto menu )
if "%c%"=="2" ( node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe & call :done "pack check" & goto menu )
if "%c%"=="3" ( node tools\make-stage2.js input\scene-research.json & call :done "stage-2 prompt" & goto menu )
if "%c%"=="4" (
  if not exist "stage2.json" ( echo.& echo   stage2.json nahi mila - Genspark ka JSON is folder mein "stage2.json" naam se save karo.& pause & goto menu )
  node tools\apply-stage2.js input\scene-research.json stage2.json & call :done "stage-2 apply" & goto menu )
if "%c%"=="5" ( node src\run.js --job=preview_hook --redo --preview-start=0   --preview-duration=120 & call :job preview_hook & goto menu )
if "%c%"=="6" ( node src\run.js --job=preview_mid  --redo --preview-start=300 --preview-duration=120 & call :job preview_mid  & goto menu )
if "%c%"=="7" ( node src\run.js --job=preview_weak --redo --preview-start=600 --preview-duration=120 & call :job preview_weak & goto menu )
if "%c%"=="8" ( node src\run.js & call :job "" & goto menu )
if "%c%"=="9" ( node tools\review-dashboard.js & call :done "review dashboard" & goto menu )
if "%c%"=="0" exit /b 0
goto menu

REM ---- simple commands: exit code batao ----
:done
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" ( echo   [OK] %~1 pura hua. ) else ( echo   [FAILED] %~1 - exit code %RC%. Upar ka message padho. )
pause
exit /b 0

REM ---- jobs: exit code + final.mp4 dono check karo ----
:job
set RC=%ERRORLEVEL%
set JOB=%~1
if "%JOB%"=="" set JOB=
echo.
if not "%RC%"=="0" (
  echo   ============================================================
  echo   [FAILED] Render pura NAHI hua ^(exit code %RC%^).
  echo   ============================================================
  if not "%~1"=="" (
    if exist "jobs\%~1\job-result.json"  echo    kya hua        : jobs\%~1\job-result.json
    if exist "jobs\%~1\NEEDS_SOURCE.csv" echo    kya theek karna: jobs\%~1\NEEDS_SOURCE.csv
    if exist "jobs\%~1\blocked-report.html" echo    poori report   : jobs\%~1\blocked-report.html
    if exist "jobs\%~1\run.log"          echo    poora log      : jobs\%~1\run.log
  )
  echo.
  echo    final.mp4 NAHI bani. Pehle upar wali file mein bataye moments theek karao,
  echo    phir option 2 aur uske baad yahi option dobara chalao.
  pause
  exit /b 0
)
if not "%~1"=="" (
  if not exist "jobs\%~1\final.mp4" (
    echo   [FAILED] exit code 0 tha par final.mp4 bani hi nahi - ye bug hai, run.log bhejo.
    pause
    exit /b 0
  )
  echo   [OK] Ho gaya. jobs\%~1\shot-review.html kholo - har shot ka asli frame wahan hai.
) else (
  echo   [OK] Ho gaya. jobs\ folder mein final.mp4 aur shot-review.html dekho.
)
pause
exit /b 0
