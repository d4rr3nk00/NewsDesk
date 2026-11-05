@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
where py >nul 2>&1
if %errorlevel% equ 0 (
  py -3 app.py
) else (
  where python >nul 2>&1
  if errorlevel 1 (
    echo Python 3.10 or later is required. Install Python and run this file again.
  ) else (
    python app.py
  )
)
pause
