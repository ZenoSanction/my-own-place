@echo off
title My Own Place
color 0A
echo.
echo  =========================================
echo    My Own Place  -  Starting up...
echo  =========================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo  Download it from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Move into the project folder first
:: This avoids ALL quoting/backslash issues with paths that have spaces
cd /d "%~dp0"

:: Install dependencies the first time
if not exist node_modules (
    echo  First run: installing dependencies ^(takes about 1 minute^)...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: npm install failed.
        pause
        exit /b 1
    )
    echo.
)

:: Verify Electron downloaded OK
if not exist "node_modules\electron\dist\electron.exe" (
    echo  Electron missing - re-running install...
    call npm install
)

echo  Launching My Own Place...

:: Use a dot "." as the app path - this resolves to the current directory
:: (which we already set to the project folder above).
:: No spaces in the argument = no quoting problem.
start "" "node_modules\electron\dist\electron.exe" .

:: Close this CMD window immediately
exit
