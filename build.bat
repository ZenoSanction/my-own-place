@echo off
title My Own Place — Build
color 0B
echo.
echo  ==========================================
echo    My Own Place  —  Build / Release
echo  ==========================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo  Download from: https://nodejs.org/
    pause & exit /b 1
)

:: Load GH_TOKEN from .env if present
if exist .env (
    for /f "tokens=1,2 delims==" %%a in (.env) do (
        if "%%a"=="GH_TOKEN" set GH_TOKEN=%%b
    )
)

:: Install dependencies if needed
if not exist node_modules (
    echo  Installing dependencies...
    call npm install
    if %errorlevel% neq 0 ( echo  ERROR: npm install failed. & pause & exit /b 1 )
)

echo  What would you like to do?
echo.
echo    [1] Build locally  (dist folder only, no upload)
echo    [2] Build + Release  (builds and uploads to GitHub)
echo.
set /p CHOICE="  Enter 1 or 2: "

if "%CHOICE%"=="2" (
    if "%GH_TOKEN%"=="" (
        echo.
        echo  ERROR: GH_TOKEN not found in .env file.
        echo  Add your GitHub token to the .env file and try again.
        pause & exit /b 1
    )
    echo.
    echo  Building and uploading release to GitHub...
    call npm run release
) else (
    echo.
    echo  Building locally...
    call npm run build
)

if %errorlevel% equ 0 (
    echo.
    echo  ==========================================
    echo    DONE!
    echo    Installer:  dist\My Own Place Setup 1.0.0.exe
    echo    Portable:   dist\My Own Place 1.0.0.exe
    echo  ==========================================
    echo.
    explorer dist
) else (
    echo.
    echo  BUILD FAILED — check the output above.
)

pause
