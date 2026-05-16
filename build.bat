@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  ClipMate Build Script
::  Double-click to build: check env -> install deps -> pack exe
:: ============================================================

echo.
echo ================================================
echo   ClipMate Build Script
echo ================================================
echo.

:: ---------- 1. Check Node.js ----------
echo [1/4] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js not found!
    echo.
    echo Please install Node.js v18+ from:
    echo   https://nodejs.org/
    echo Make sure to check "Add to PATH" during installation.
    echo.
    pause
    exit /b 1
)
for /f "tokens=1,* delims=v" %%a in ('node --version') do set NODE_VER=%%b
echo        Node.js v%NODE_VER%  OK

:: ---------- 2. Check npm ----------
echo.
echo [2/4] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found! Please reinstall Node.js.
    pause
    exit /b 1
)
echo        npm OK

:: ---------- 3. Install dependencies ----------
echo.
echo [3/4] Checking dependencies...
if not exist "node_modules\" (
    echo        node_modules not found. Installing dependencies...
    echo        This may take 2-5 minutes on first run.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed!
        echo.
        echo Possible causes:
        echo   1. Network connection issue
        echo   2. Firewall blocking npm
        echo.
        echo Try setting a mirror and re-run:
        echo   npm config set registry https://registry.npmmirror.com
        echo.
        pause
        exit /b 1
    )
    echo        Dependencies installed successfully.
) else (
    echo        Dependencies already installed, skipping.
)

:: ---------- 4. Build & Package ----------
echo.
echo [4/4] Building frontend and packaging Electron app...
echo        (First time may take a while to download Electron binary)
echo.
call npm run pack 2>nul

:: Check result by file existence instead of errorlevel
:: (electron-builder warnings can cause false errorlevel)
if not exist "dist-electron\*.exe" (
    echo.
    echo [ERROR] Build or packaging failed!
    echo.
    echo Common causes:
    echo   1. Electron binary download failed (network issue)
    echo      Fix: set mirror and re-run this script
    echo        set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    echo.
    echo   2. Vite build error
    echo      Fix: run "npm run build" manually to see the error
    echo.
    pause
    exit /b 1
)

:: ---------- Done ----------
echo.
echo ================================================
echo    BUILD SUCCESSFUL
echo ================================================
echo.
for %%f in (dist-electron\*.exe) do (
    echo   Installer: dist-electron\%%~nxf
    echo.
    echo   Size:
    for /f "usebackq" %%s in (`powershell -NoProfile -Command "[math]::Round((Get-Item 'dist-electron\%%~nxf').Length/1MB)"`) do echo   %%~s MB
)
echo.
echo   You can now run the installer to install ClipMate.
echo ================================================
echo.
pause
endlocal
