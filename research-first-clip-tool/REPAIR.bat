@echo off
REM ============================================================
REM  REPAIR.bat — pack ko theek karne ka poora rasta, ek jagah.
REM
REM  Yahan sabse zaroori baat: prompts ab KHUD-MUKHTAR hain. Purani
REM  Genspark chat ki zaroorat NAHI hai. Har file kisi bhi nayi chat,
REM  naye account ya doosre tool (Gemini/ChatGPT/Perplexity) mein
REM  paste ho sakti hai — jiske paas live web ho.
REM
REM  Aur do cheezein AI ke bina hi theek hoti hain (option 3 aur 4).
REM  Genspark ka ek-message-per-din unpar mat kharch karo.
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

if "%c%"=="1" ( node tools\repair.js input\scene-research.json & call :done "repair prompts" & goto menu )
if "%c%"=="2" (
  echo.
  echo   Pehle DRY RUN - dekho kya lagega, pack abhi nahi badlega:
  echo.
  node tools\apply-repair.js input\scene-research.json
  echo.
  set /p yn=  Ye sab laga du? (y/n)
  if /i "!yn!"=="y" (
    node tools\apply-repair.js input\scene-research.json --apply --archive
    if not errorlevel 1 (
      echo.
      echo   Ab pack check apne aap chala raha hoon...
      echo.
      node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe
    )
  ) else ( echo   Theek hai - kuch nahi badla. )
  call :done "repair apply" & goto menu )
if "%c%"=="3" (
  echo.
  echo   Pehle dekho kya badlega:
  echo.
  node tools\fix-cues.js input\scene-research.json input\voiceover.srt
  echo.
  set /p yn=  Ye cue theek kar du? (y/n)
  if /i "!yn!"=="y" ( node tools\fix-cues.js input\scene-research.json input\voiceover.srt --apply ) else ( echo   Theek hai - kuch nahi badla. )
  call :done "cue fix" & goto menu )
if "%c%"=="4" ( node tools\migrate-pack.js input\scene-research.json input\voiceover.srt --apply & call :done "criticality migrate" & goto menu )
if "%c%"=="5" ( node tools\migrate-pack.js input\scene-research.json input\voiceover.srt --apply --approve-borrow & call :done "migrate + borrow" & goto menu )
if "%c%"=="6" ( node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe & call :done "pack check" & goto menu )
if "%c%"=="0" exit /b 0
goto menu

:done
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" ( echo   [OK] %~1 pura hua. ) else (
  if "%RC%"=="2" ( echo   [ACTION] %~1 - kaam baaki hai, upar ka message padho. ) else ( echo   [FAILED] %~1 - exit code %RC%. Upar ka message padho. )
)
pause
exit /b 0
