@echo off
REM ============================================================
REM  REPAIR.bat — pack ko theek karne ka poora rasta, ek jagah.
REM
REM  M4 FIX: pehle confirm wale prompts if-block ke ANDAR the aur unme
REM  "(y/n)" likha tha. cmd.exe us ")" ko block ka END samajh leta hai —
REM  isliye option 3/4 chalte hi nahi the, aur phir bhi "[OK] pura hua"
REM  chhap jata tha. Asli run mein isi wajah se 10 cue fixes aur 109
REM  criticality values kabhi apply hi nahi hui. Ab har action apni alag
REM  label par jata hai, koi nested paren block nahi.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
:menu
cls
echo ==============================================================
echo   PACK REPAIR
echo ==============================================================
for /f "delims=" %%s in ('node tools\pack-status.js 2^>nul') do set PSTAT=%%s
if not defined PSTAT set PSTAT=NOT_CHECKED  (pehle CHECKPACK.bat chalao)
echo   pack check : !PSTAT!
set PSTAT=
echo ==============================================================
echo.
echo   AI SE (chhote standalone prompts):
echo     1. Repair prompts banao   -^> output\repair\ mein files
echo     2. Jawab lagao            -^> output\repair\responses\ ki saari files
echo.
echo   BINA AI KE (yahin, turant):
echo     3. Cue theek karo         ^(voiceover.srt se hubahu^)
echo     4. Criticality migrate    ^(HOOK / HARD_EVIDENCE / NORMAL^)
echo     5. Criticality + purana udhaar manzoor karo
echo.
echo     6. Pack check dobara chalao
echo     0. Bahar
echo.
set /p c=  Kya karna hai (0-6)?

if "%c%"=="1" goto prompts
if "%c%"=="2" goto applyrepair
if "%c%"=="3" goto cuefix
if "%c%"=="4" goto migrate
if "%c%"=="5" goto migrateborrow
if "%c%"=="6" goto recheck
if "%c%"=="0" exit /b 0
goto menu

:prompts
node tools\repair.js input\scene-research.json
call :done "repair prompts"
goto menu

:applyrepair
echo.
echo   Pehle DRY RUN - dekho kya lagega, pack abhi nahi badlega:
echo.
node tools\apply-repair.js input\scene-research.json
echo.
set /p yn=  Ye sab laga du? y = haan, kuch aur = nahi :
if /i not "%yn%"=="y" goto cancelled
node tools\apply-repair.js input\scene-research.json --apply --archive
if errorlevel 1 goto applydone
echo.
echo   Ab pack check apne aap chala raha hoon...
echo.
node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe
:applydone
call :done "repair apply"
goto menu

:cuefix
echo.
echo   Pehle dekho kya badlega:
echo.
node tools\fix-cues.js input\scene-research.json input\voiceover.srt
echo.
set /p yn=  Ye cue theek kar du? y = haan, kuch aur = nahi :
if /i not "%yn%"=="y" goto cancelled
node tools\fix-cues.js input\scene-research.json input\voiceover.srt --apply
call :done "cue fix"
goto menu

:migrate
node tools\migrate-pack.js input\scene-research.json input\voiceover.srt --apply
call :done "criticality migrate"
goto menu

:migrateborrow
node tools\migrate-pack.js input\scene-research.json input\voiceover.srt --apply --approve-borrow
call :done "migrate + borrow"
goto menu

:recheck
node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe
call :done "pack check"
goto menu

REM ---- user ne mana kiya: ye SUCCESS nahi hai ----
:cancelled
echo.
echo   CANCELLED - NO CHANGES APPLIED
echo   ^(pack bilkul waisa hi hai jaisa tha. Dobara chalana ho to wahi option dabao.^)
pause
goto menu

:done
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" ( echo   [OK] %~1 pura hua. ) else (
  if "%RC%"=="2" ( echo   [ACTION] %~1 - kaam baaki hai, upar ka message padho. ) else ( echo   [FAILED] %~1 - exit code %RC%. Upar ka message padho. )
)
pause
exit /b 0
