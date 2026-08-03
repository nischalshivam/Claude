@echo off
REM ============================================================
REM  START_HERE.bat — ek hi jagah se poora kaam.
REM
REM  M3.6.1: menu ab pack ka ASLI status dikhata hai (tools/pack-status.js
REM  se). Pehle ye sirf ye dekhta tha ki report FILE maujood hai ya nahi,
REM  aur "ho chuka" likh deta tha — chahe wo report kisi purane pack ki ho.
REM  Usi jhoothi line par bharosa karke user ne 5/6/7 chalaye aur teeno
REM  exit code 3 par ruke.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
:menu
cls
echo ==============================================================
echo   RESEARCH-FIRST CLIP TOOL  -  M4.1
echo ==============================================================
if exist "input\scene-research.json" (echo   pack       : input\scene-research.json  [mila]) else (echo   pack       : NAHI MILA  -^> Genspark ka JSON input\ mein daalo)
if exist "input\voiceover.srt" (echo   voiceover  : input\voiceover.srt  [mila]) else (echo   voiceover  : NAHI MILA  -^> preview/render nahi chalega)
for /f "delims=" %%s in ('node tools\pack-status.js 2^>nul') do set PSTAT=%%s
if not defined PSTAT set PSTAT=NOT_CHECKED  (option 2 pehle chalao)
echo   pack check : !PSTAT!
set PSTAT=
echo ==============================================================
echo.
echo   1. Setup check              ^(sabse pehle, ek baar^)
echo   2. Pack ka report card      ^(research ke baad HAR baar - ZAROORI^)
echo   3. Repair prompts banao     ^(chhote, kisi bhi nayi chat mein chalte hain^)
echo   4. Repair jawab lagao       ^(jitne JSON aaye hain, sab ek saath^)
echo   5. Preview - shuruat        ^(pehle 120 second^)
echo   6. Preview - beech se       ^(300s se 120 second^)
echo   7. Preview - kamzor hissa   ^(600s se 120 second^)
echo   8. Poora render             ^(sirf jab pack PRODUCTION_READY ho^)
echo   9. Review dashboard         ^(teeno preview ek saath^)
echo.
echo   D. Draft banao              ^(poori video, khaali jagah par MISSING card^)
echo   R. Draft - saaf shuruat     ^(sab dobara download - normally zaroorat nahi^)
echo   M. Missing media complete karo  ^(dashboard - apni images/videos daalo^)
echo   L. Local fixes ^(bina AI ke^) - cue theek karo + criticality migrate
echo   0. Bahar
echo.
set /p c=  Kya karna hai (0-9, D, R, M, L)?

if "%c%"=="1" ( node src\run.js --only=check & call :done "setup check" & goto menu )
if "%c%"=="2" ( node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe & call :check & goto menu )
if "%c%"=="3" ( node tools\repair.js input\scene-research.json & call :done "repair prompts" & goto menu )
if "%c%"=="4" (
  node tools\apply-repair.js input\scene-research.json --apply
  if not errorlevel 1 (
    echo.
    echo   Repair lag gaya - ab pack check apne aap chala raha hoon...
    echo.
    node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe
  )
  call :done "repair apply" & goto menu )
if "%c%"=="5" ( node src\run.js --job=preview_hook --redo --preview-start=0   --preview-duration=120 & call :job preview_hook & goto menu )
if "%c%"=="6" ( node src\run.js --job=preview_mid  --redo --preview-start=300 --preview-duration=120 & call :job preview_mid  & goto menu )
if "%c%"=="7" ( node src\run.js --job=preview_weak --redo --preview-start=600 --preview-duration=120 & call :job preview_weak & goto menu )
if "%c%"=="8" ( node src\run.js & call :job "" & goto menu )
if "%c%"=="9" ( node tools\review-dashboard.js & call :done "review dashboard" & goto menu )
if /i "%c%"=="D" ( node src\run.js --draft & call :job "" & goto menu )
if /i "%c%"=="R" ( node src\run.js --draft --redo & call :job "" & goto menu )
if /i "%c%"=="M" ( node tools\ui.js & goto menu )
if /i "%c%"=="L" goto local
if "%c%"=="0" exit /b 0
goto menu

REM ---- local fixes: ye Genspark/Gemini ke bina hote hain ----
:local
cls
echo ==============================================================
echo   LOCAL FIXES - inke liye kisi AI ki zaroorat NAHI hai
echo ==============================================================
echo.
echo   Ye dono cheezein tumhare apne computer par ho jati hain.
echo   Genspark ka ek-message-per-din yahan kharch mat karo.
echo.
echo   1. Cue theek karo        ^(narration cue ko voiceover.srt se hubahu milao^)
echo   2. Criticality migrate   ^(har moment par HOOK/HARD_EVIDENCE/NORMAL^)
echo   3. Criticality + udhaar manzoor karo ^(purani allowed_pack_ids waali^)
echo   0. Wapas
echo.
set /p lc=  Kya karna hai (0-3)?
if "%lc%"=="1" ( node tools\fix-cues.js input\scene-research.json input\voiceover.srt --apply & call :done "cue fix" & goto menu )
if "%lc%"=="2" ( node tools\migrate-pack.js input\scene-research.json input\voiceover.srt --apply & call :done "criticality migrate" & goto menu )
if "%lc%"=="3" ( node tools\migrate-pack.js input\scene-research.json input\voiceover.srt --apply --approve-borrow & call :done "migrate + borrow" & goto menu )
if "%lc%"=="0" goto menu
goto local

REM ---- pack check: exit 2 ka matlab "tool toota" NAHI hai ----
:check
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" ( echo   [OK] Pack PRODUCTION READY hai - option 5/6/7 phir 8 chala sakte ho. ) else (
  if "%RC%"=="2" (
    echo   [ACTION] Check pura chala. Pack ko research chahiye - upar list hai.
    echo            Ye tool ki galti nahi hai. Aage kya karna hai:
    echo              - option 3 se repair prompts banao ^(kisi bhi nayi chat mein chalenge^)
    echo              - option L se cue/criticality bina AI ke theek karo
    echo              - diagnostic preview 5/6/7 ab bhi chal sakte hain
  ) else (
    echo   [FAILED] pack check chal hi nahi paya - exit code %RC%. Upar ka message padho.
  )
)
pause
exit /b 0

REM ---- simple commands: exit code batao ----
:done
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" ( echo   [OK] %~1 pura hua. ) else (
  if "%RC%"=="2" ( echo   [ACTION] %~1 - kaam baaki hai, upar ka message padho. ) else ( echo   [FAILED] %~1 - exit code %RC%. Upar ka message padho. )
)
pause
exit /b 0

REM ---- jobs: exit code + final.mp4 dono check karo ----
:job
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="3" (
  echo   ============================================================
  echo   [BLOCKED] Ye run production gate par ruka - engine chala hi nahi.
  echo   ============================================================
  if not "%~1"=="" (
    if exist "jobs\%~1\blocked-report.html" echo    kyun ruka     : jobs\%~1\blocked-report.html
    if exist "jobs\%~1\job-result.json"     echo    machine-readable: jobs\%~1\job-result.json
  )
  echo.
  echo    Upar likha hai ki kya chahiye. Aam taur par: option 2 chalao,
  echo    ya pack ko option 3/4/L se theek karao.
  pause
  exit /b 0
)
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
