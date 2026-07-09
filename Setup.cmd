@echo off
rem Run this once, before the first use. Safe to run again any time.
title Fotomalovanky - setup
cd /d "%~dp0"

echo.
echo   Setting up Fotomalovanky. This takes a few minutes the first time.
echo.

rem Ask node itself rather than `where node`: `where` is missing from some stripped PATHs.
node --version >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Get the LTS version from https://nodejs.org
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

echo   [1/3] Installing the tool's components...
call npm install --no-fund --no-audit
if errorlevel 1 goto failed

echo.
echo   [2/3] Installing the browser used to make the PDFs...
call npx playwright install chromium
if errorlevel 1 goto failed

echo.
echo   [3/3] Settings...
if exist "config.json" (
  echo   config.json already exists - leaving it alone.
) else (
  copy /y "config.example.json" "config.json" >nul
  if errorlevel 1 goto failed
  echo.
  echo   A settings file was created. Notepad will now open it.
  echo   Paste your private generator link after "baseUrl", between the quotes.
  echo   It looks like:  https://fotomalovanky-app.onrender.com/YOUR-LINK/
  echo   Then save the file and close Notepad.
  echo.
  pause
  notepad config.json
)

echo.
echo   Setup finished. Double-click Fotomalovanky.cmd to start.
echo.
pause
exit /b 0

:failed
echo.
echo   Setup did not finish. Check your internet connection and try again.
echo   If it keeps failing, send the text above to whoever set this up.
echo.
pause
exit /b 1
