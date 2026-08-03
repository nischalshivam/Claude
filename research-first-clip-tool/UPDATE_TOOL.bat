@echo off
REM ============================================================
REM  UPDATE_TOOL.bat — naye version ka CODE lagao, apna kaam bachao.
REM
REM  Kyun ye bana: "purana folder replace kar do" wali salaah ne asli
REM  nuksaan kiya — naye ZIP ke saath purana pack aa gaya aur 19 locators
REM  + 19 frame hints chup-chaap gayab ho gaye. Ye ab kabhi nahi hoga.
REM
REM  Ye sirf CODE badalta hai. Ye teen cheezein KABHI nahi chhuta:
REM     input\      (aapka pack, voiceover, script)
REM     DATA\       (aapki dhoondhi hui images/videos)
REM     jobs\       (downloads, clips, cache — ghanton ka kaam)
REM
REM  Chalane ka tarika:
REM     UPDATE_TOOL.bat "C:\path\to\naya\research-first-clip-tool"
REM ============================================================
setlocal
cd /d "%~dp0"
set SRC=%~1
if "%SRC%"=="" (
  echo.
  echo   Naye version ka folder batao:
  echo      UPDATE_TOOL.bat "C:\Users\Dell\Downloads\research-first-clip-tool"
  echo.
  pause & exit /b 1
)
if not exist "%SRC%\src\run.js" (
  echo   [FAIL] "%SRC%" mein tool ka code nahi mila ^(src\run.js nahi hai^).
  pause & exit /b 1
)

echo ==============================================================
echo   TOOL UPDATE - sirf code, aapka data waisa ka waisa
echo ==============================================================
echo.
echo   yahan se : %SRC%
echo   yahan par: %CD%
echo.
echo   Ye badlega  : src, tools, lib, prompts, schemas, tests, *.bat, README, config
echo   Ye NAHI     : input\, DATA\, jobs\, output\
echo.
set /p yn=  Aage badhu? y = haan, kuch aur = nahi :
if /i not "%yn%"=="y" (
  echo   CANCELLED - NO CHANGES APPLIED
  pause & exit /b 0
)

REM purane code ka backup — rollback ke liye
set STAMP=%DATE:/=-%_%TIME::=-%
set STAMP=%STAMP: =_%
set BK=_backup_code_%RANDOM%
mkdir "%BK%" 2>nul
for %%D in (src tools lib prompts schemas smoke-test) do if exist "%%D" xcopy /E /I /Q /Y "%%D" "%BK%\%%D" >nul
copy /Y *.bat "%BK%\" >nul 2>nul
copy /Y package.json "%BK%\" >nul 2>nul
copy /Y config.json "%BK%\" >nul 2>nul
echo   purane code ka backup: %BK%\
echo.

for %%D in (src tools lib prompts schemas tests smoke-test) do (
  if exist "%SRC%\%%D" (
    rmdir /S /Q "%%D" 2>nul
    xcopy /E /I /Q /Y "%SRC%\%%D" "%%D" >nul
    echo   updated: %%D\
  )
)
for %%F in (START_HERE.bat REPAIR.bat CHECK.bat CHECKPACK.bat PREVIEW.bat START.bat START_UI.bat UPDATE_TOOL.bat package.json README.md BUILD_INFO.json RAW-TEST-LOG.txt RAW-REGRESSION-LOG.txt) do (
  if exist "%SRC%\%%F" copy /Y "%SRC%\%%F" "%%F" >nul & echo   updated: %%F
)
REM config.json sirf tab jab yahan hai hi nahi — aapki settings nahi udaani
if not exist "config.json" if exist "%SRC%\config.json" copy /Y "%SRC%\config.json" "config.json" >nul

echo.
echo ==============================================================
echo   Ho gaya. Aapka data safe hai:
if exist "input\scene-research.json" (echo      input\scene-research.json    [surakshit]) else (echo      input\scene-research.json    [nahi hai])
if exist "DATA"  (echo      DATA\                       [surakshit]) else (echo      DATA\                       [abhi bana hi nahi])
if exist "jobs"  (echo      jobs\                       [surakshit - downloads bache hue hain]) else (echo      jobs\                       [abhi bana hi nahi])
echo.
echo   Ab START_HERE.bat chalao. Sab kuch wahin se milega jahan chhoda tha.
echo   Rollback chahiye to %BK%\ se files wapas copy kar lo.
echo ==============================================================
pause
