@echo off
chcp 65001 >nul 2>nul
title Kyobo eBook PDF Merger
echo.
echo  ========================================
echo   Kyobo eBook PDF Merger
echo  ========================================
echo.

python --version >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Python not found.
    echo  Download: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

echo  [1/2] Installing dependencies...
pip install Pillow pypdf --quiet 2>nul
echo  [2/2] Generating PDF...
echo.
python "%~dp0merge_pdf.py" "%~dp0." --size a4
echo.
pause
