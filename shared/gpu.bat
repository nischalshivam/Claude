@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title media_index - GPU

REM ------------------------------------------------------------------------
REM  GPU ko sach me chalu karna, aur pehle ye dekhna ki wo chal bhi payega.
REM
REM  Quadro P1000 = Pascal, 4 GB VRAM. SigLIP-base ise easily fit karta hai
REM  (poora model ~800 MB fp32, batch 16 frames ~200 MB). faster-whisper ka
REM  base.en bhi. Par ye "install karo aur ho gaya" nahi hai:
REM
REM    - torch ka default pip wheel CPU-only hota hai. CUDA wala alag hai.
REM    - faster-whisper ko cuBLAS + cuDNN chahiye, jo torch ke saath aate
REM      hain par PATH me hone chahiye.
REM
REM  Isliye ye file pehle NAAPTI hai, phir badalti hai, phir DOBARA naapti
REM  hai. Number ke bina "tez ho gaya" bolna wahi purani galti hai.
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
echo     GPU ki jaanch
echo   ================================================================
echo.

%PY% -m media_index gpu
echo.

echo   ----------------------------------------------------------------
echo   GPU chalu karne ke liye CUDA wala torch chahiye. Ye ~2.5 GB
echo   download hai aur CPU wale torch ko replace karega.
echo.
echo   Aage badhna hai? Ctrl+C dabao rukne ke liye.
echo   ----------------------------------------------------------------
pause

echo.
echo   purana torch hataya ja raha hai...
%PY% -m pip uninstall -y torch torchvision torchaudio

echo.
REM Version pin kiya hua hai, latest nahi. Naye torch builds Pascal
REM (compute 6.1 - tumhara P1000) ka support hata rahe hain; 2.5.1+cu121
REM wo abhi rakhta hai. "Latest" lagane par card dikhega par kaam nahi
REM karega, aur error samajhna mushkil hoga.
echo   torch 2.5.1 + CUDA 12.1 install ho raha hai (Pascal supported)...
%PY% -m pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121
if errorlevel 1 (
    echo.
    echo   CUDA wala torch install nahi hua. CPU wala wapas laga rahe hain
    echo   taaki tool chalta rahe.
    echo.
    %PY% -m pip install torch
    pause
    exit /b 1
)

echo.
echo   ================================================================
echo     Ab dobara jaanch - kya sach me badla?
echo   ================================================================
echo.
%PY% -m media_index gpu
echo.
echo   Agar upar "cuda" likha hai to indexing ab GPU par chalegi.
echo   Agar abhi bhi "cpu" hai to koi baat nahi - tool waise hi chalta
echo   hai, bas dhima. Ye correctness ki problem nahi hai.
echo.
pause
