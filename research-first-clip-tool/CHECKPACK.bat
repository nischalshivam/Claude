@echo off
REM ============================================================
REM  CHECKPACK.bat — research pack ka REPORT CARD (render se PEHLE).
REM
REM  Ye poora render karne ki zaroorat khatam karta hai. Ye batata hai:
REM    - narration ke kitne SECONDS ke paas asli scene ka evidence hai
REM    - kaunse dialogue asli captions mein NAHI mile (yaani clip nahi lagegi)
REM    - kaunse source dead ho gaye, kaunse timestamp episode se bahar hain
REM    - render ke baad visual mix kya aayega
REM
REM  Aur do files banata hai (output\ folder mein):
REM    pack-report.json     -> numbers
REM    NEEDS_RESEARCH.txt   -> Genspark/Gemini mein paste karne wala work order
REM
REM   CHECKPACK.bat          -> poora check (sources ke asli captions bhi)
REM   CHECKPACK.bat fast     -> sirf offline check (internet nahi lagta, 8 sec)
REM ============================================================
cd /d "%~dp0"
set EXTRA=
if /I "%1"=="fast" set EXTRA=--no-probe
node tools\check-pack.js input\scene-research.json input\voiceover.srt %EXTRA%
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo Pack theek hai - ab START.bat / PREVIEW.bat chala sakte ho.
) else if "%RC%"=="2" (
  echo Pack weak hai - output\NEEDS_RESEARCH.txt kholo aur wo text Genspark mein paste karo.
) else (
  echo Pack padha nahi ja saka - upar ke [FAIL] dekho.
)
pause
exit /b %RC%
