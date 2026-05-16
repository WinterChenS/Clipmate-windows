@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  ClipMate Build Script (Tauri)
::  Double-click to build: check env -> install deps -> build
:: ============================================================

echo.
echo ================================================
echo   ClipMate Build Script (Tauri Edition)
echo ================================================
echo.

:: ---------- 1. Check Node.js ----------
echo [1/5] Checking Node.js...
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

:: ---------- 2. Check Rust ----------
echo.
echo [2/5] Checking Rust toolchain...
where cargo >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Rust/Cargo not found!
    echo.
    echo Please install Rust from:
    echo   https://rustup.rs/
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('cargo --version') do set RUST_VER=%%v
echo        %RUST_VER%  OK

:: ---------- 3. Check npm ----------
echo.
echo [3/5] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found! Please reinstall Node.js.
    pause
    exit /b 1
)
echo        npm OK

:: ---------- 4. Install dependencies ----------
echo.
echo [4/5] Checking dependencies...
if not exist "node_modules\" (
    echo        node_modules not found. Installing frontend dependencies...
    echo        This may take 1-2 minutes on first run.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed!
        echo.
        echo Try setting a mirror and re-run:
        echo   npm config set registry https://registry.npmmirror.com
        echo.
        pause
        exit /b 1
    )
    echo        Frontend dependencies installed.
) else (
    echo        Frontend dependencies already installed, skipping.
)

:: ---------- 5. Build with Tauri ----------
echo.
echo [5/5] Building ClipMate with Tauri...
echo        (First build may take several minutes to compile Rust dependencies)
echo.

:: Sync version from git tag to package.json
for /f "delims=" %%v in ('git describe --tags --abbrev=0 2^>nul') do set GIT_TAG=%%v
if defined GIT_TAG (
    set GIT_VERSION=!GIT_TAG:v=!
    echo        Version from git tag: !GIT_TAG! -^> !GIT_VERSION!
    node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='!GIT_VERSION!';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
) else (
    echo        No git tag found, using version from package.json
)

call npx tauri build

if errorlevel 1 (
    echo.
    echo [ERROR] Tauri build failed!
    echo.
    echo Common causes:
    echo   1. Rust compilation error - check error messages above
    echo   2. Frontend build error - run "npm run build" manually
    echo   3. Missing Tauri CLI - run "npm install" again
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

:: List output files
set OUTPUT_DIR=src-tauri\target\release\bundle
if exist "%OUTPUT_DIR%\nsis\*.exe" (
    for %%f in ("%OUTPUT_DIR%\nsis\*.exe") do (
        echo   NSIS Installer: %%~nxf
        for /f "usebackq" %%s in (`powershell -NoProfile -Command "[math]::Round((Get-Item '%%f').Length/1MB)"`) do echo   Size: %%~s MB
        echo.
    )
)
if exist "%OUTPUT_DIR%\msi\*.msi" (
    for %%f in ("%OUTPUT_DIR%\msi\*.msi") do (
        echo   MSI Installer: %%~nxf
        for /f "usebackq" %%s in (`powershell -NoProfile -Command "[math]::Round((Get-Item '%%f').Length/1MB)"`) do echo   Size: %%~s MB
        echo.
    )
)

echo   Standalone exe: src-tauri\target\release\clipmate.exe
echo.
echo   You can now run the installer to install ClipMate.
echo ================================================
echo.
pause
endlocal
