@echo off
rem Double-click this to start Fotomalovanky. It opens the tool in your browser.
rem Leave the black window open while you work; closing it stops the tool.
title Fotomalovanky
cd /d "%~dp0"

rem Ask node itself rather than `where node`: it is the thing we actually need, and `where`
rem is missing from some stripped PATHs.
node --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo.
  echo   Install it from https://nodejs.org  ^(choose the LTS version^),
  echo   then run Setup.cmd once, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   The tool has not been set up yet. Run Setup.cmd first.
  echo.
  pause
  exit /b 1
)

if not exist "config.json" (
  echo.
  echo   config.json is missing. Run Setup.cmd first.
  echo.
  pause
  exit /b 1
)

node src\ui\server.js
rem Reached when the server stops or fails to start: keep the window so the reason is readable.
echo.
pause
