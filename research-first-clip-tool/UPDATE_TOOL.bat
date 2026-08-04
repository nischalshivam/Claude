@echo off
REM ============================================================
REM  UPDATE_TOOL.bat — naye version ka CODE lagao, apna kaam bachao.
REM
REM  Kyun ye bana: "purana folder replace kar do" wali salaah ne asli
REM  nuksaan kiya — naye ZIP ke saath purana pack aa gaya aur 19 locators
REM  + 19 frame hints chup-chaap gayab ho gaye. Ye ab kabhi nahi hoga.
REM
REM  Ye khud samajh leta hai ki aap kahan se chala rahe ho:
REM    - naye (unzip kiye hue) folder se  -> puchhega "purana project kahan hai"
REM    - purane project folder se         -> puchhega "naya code kahan hai"
REM  Dono taraf se kaam karta hai. Aapko yaad rakhne ki zaroorat nahi.
REM
REM  Ye teen cheezein KABHI nahi chhuta:
REM     input\   (aapka pack, voiceover, script)
REM     DATA\    (aapki dhoondhi hui images/videos)
REM     jobs\    (downloads, clips, cache - ghanton ka kaam)
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

cls
echo ==============================================================
echo   TOOL UPDATE - sirf code badlega, aapka kaam waisa ka waisa
echo ==============================================================
echo.

REM --- ye folder naya code hai ya chalta hua project? ---
set ISPROJECT=0
if exist "input\scene-research.json" set ISPROJECT=1
if exist "jobs" set ISPROJECT=1
if exist "DATA" set ISPROJECT=1

if "%ISPROJECT%"=="1" goto ask_new
goto ask_project

REM ============================================================
:ask_project
REM  Hum NAYE code wale folder mein hain. Purana project maango.
echo   Ye folder naya version lag raha hai ^(abhi tak koi kaam nahi hua^).
echo.
echo   Aapka CHALTA HUA project folder kahan hai?
echo   ^(wahi jisme aapka input\scene-research.json aur jobs\ folder hai^)
echo.
echo   Folder ko yahan DRAG karke chhod do, ya path type karo:
set /p DST=  ^> 
if "%DST%"=="" goto nothing
set DST=%DST:"=%
if not exist "%DST%\input" (
  echo.
  echo   [RUKO] "%DST%" mein input\ folder nahi mila.
  echo          Kya ye sach mein aapka project folder hai?
  echo.
  pause & exit /b 1
)
set SRC=%CD%
goto confirm

REM ============================================================
:ask_new
REM  Hum PROJECT folder mein hain. Naya code maango.
echo   Ye aapka chalta hua project folder hai. Achha.
echo.
echo   Naya version kahan unzip kiya hai?
echo   ^(usme src\run.js hona chahiye^)
echo.
echo   Folder ko yahan DRAG karke chhod do, ya path type karo:
set /p SRC=  ^> 
if "%SRC%"=="" goto nothing
set SRC=%SRC:"=%
if not exist "%SRC%\src\run.js" (
  echo.
  echo   [RUKO] "%SRC%" mein tool ka code nahi mila ^(src\run.js nahi hai^).
  echo          Shayad ek folder andar ho - dobara dekh lo.
  echo.
  pause & exit /b 1
)
set DST=%CD%
goto confirm

REM ============================================================
:confirm
echo.
echo --------------------------------------------------------------
echo   naya code yahan se : %SRC%
echo   project yahan par  : %DST%
echo.
echo   BADLEGA  : src, server, tools, lib, prompts, schemas, tests, docs, reference-pack, *.bat
echo   NAHI BADLEGA : input\  DATA\  jobs\  output\  config.json
echo --------------------------------------------------------------
echo.
set /p yn=  Aage badhu? y = haan, kuch aur = nahi : 
if /i not "%yn%"=="y" goto nothing

REM --- purane code ka backup (rollback ke liye) ---
set BK=%DST%\_backup_code_%RANDOM%
mkdir "%BK%" 2>nul
REM  M4.2.1: backup mein bhi wahi folder jo update mein hain - warna rollback
REM  aadha hota hai (docs\ pichhli baar na copy hota tha, na backup)
for %%D in (src server tools lib prompts schemas tests docs smoke-test reference-pack) do if exist "%DST%\%%D" xcopy /E /I /Q /Y "%DST%\%%D" "%BK%\%%D" >nul
copy /Y "%DST%\*.bat" "%BK%\" >nul 2>nul
copy /Y "%DST%\package.json" "%BK%\" >nul 2>nul
copy /Y "%DST%\BUILD_INFO.json" "%BK%\" >nul 2>nul
echo.
echo   purane code ka backup: %BK%
echo.

for %%D in (src server tools lib prompts schemas tests docs smoke-test reference-pack) do (
  if exist "%SRC%\%%D" (
    if exist "%DST%\%%D" rmdir /S /Q "%DST%\%%D" 2>nul
    xcopy /E /I /Q /Y "%SRC%\%%D" "%DST%\%%D" >nul
    echo   updated: %%D\
  )
)
for %%F in (START_HERE.bat REPAIR.bat CHECK.bat CHECKPACK.bat PREVIEW.bat START.bat START_UI.bat UPDATE_TOOL.bat package.json README.md PEHLE_YE_PADHO.txt KNOWN_LIMITATIONS.md BUILD_INFO.json RAW-TEST-LOG.txt RAW-REGRESSION-LOG.txt RAW-SERVER-LOG.txt) do (
  if exist "%SRC%\%%F" copy /Y "%SRC%\%%F" "%DST%\%%F" >nul & echo   updated: %%F
)
REM config.json sirf tab jab wahan hai hi nahi - aapki settings nahi udaani
if not exist "%DST%\config.json" if exist "%SRC%\config.json" copy /Y "%SRC%\config.json" "%DST%\config.json" >nul

echo.
REM --- ab ANDAAZA nahi, sach check karo (M4.2.1) ---
pushd "%DST%"
node tools\verify-update.js --src="%SRC%"
set VRC=%ERRORLEVEL%
popd

echo.
echo ==============================================================
if "%VRC%"=="0" (
  echo   HO GAYA - update check bhi pass hua.
) else (
  echo   UPDATE LAGA, PAR CHECK MEIN KUCH KAMI HAI - upar padho.
)
echo.
echo   AB KYA KARNA HAI:
echo      1. Apne project folder mein jao: %DST%
echo      2. PEHLE_YE_PADHO.txt kholo ^(8 step likhe hain^)
echo      3. Phir START_HERE.bat chalao
echo.
echo   Rollback chahiye to %BK% se files wapas copy kar lo.
echo   ^(usme src server tools lib prompts schemas tests docs reference-pack sab hai^)
echo ==============================================================
pause
REM M5.0-A fix: verify FAIL hone par bhi exit 0 dena galat tha — automation
REM aur aane wala UI updater adhoore update ko "green" samajh lete. Ab asli
REM verify ka exit code aage bhejte hain.
exit /b %VRC%

:nothing
echo.
echo   CANCELLED - NO CHANGES APPLIED
echo   ^(kuch nahi badla. Jab chaho dobara chala lena.^)
pause
exit /b 0
