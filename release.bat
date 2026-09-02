@echo off
REM Convoy — one-click release. Builds the APK + deploys the site + uploads the APK.
REM Double-click this file, or run from a terminal:  release.bat
REM Optional flags pass through to release.js, e.g.  release.bat --no-apk
cd /d "%~dp0"
setlocal EnableDelayedExpansion

echo.
echo ================================================================
echo   CONVOY RELEASE
echo   Builds the APK + pushes it and the website to the live server.
echo ================================================================
echo.

REM ---- find Node first (before any confirm) so we don't hang on a missing dep ----
where node >nul 2>nul
if !errorlevel! neq 0 (
  echo [ERROR] Node.js not found on PATH.
  echo         Install from https://nodejs.org ^(LTS^), reopen the folder, retry.
  echo.
  pause
  exit /b 1
)

REM ---- confirm before pushing to the live site ----
echo This will PUSH to the live server. Options:
echo   [Enter/Y] full release ^(APK + site^)
echo   type --no-apk after this for site-only, --no-site for APK-only.
echo.
set /p CONFIRM="Proceed with a FULL release? [Y/n]: "
if /i "!CONFIRM!"=="n" goto :nope
if /i "!CONFIRM!"=="no" goto :nope

REM ---- make sure deploy deps are installed (ssh2) ----
if not exist "deploy\node_modules\ssh2" (
  echo.
  echo -^> Installing deploy dependency ^(ssh2^)...
  pushd deploy
  call npm install --no-fund --no-audit
  set DEPLOY_RC=!errorlevel!
  popd
  if !DEPLOY_RC! neq 0 (
    echo.
    echo [ERROR] npm install failed in deploy\.
    echo.
    pause
    exit /b 1
  )
)

REM ---- run the release ----
echo.
echo ================================================================
echo   Running: node release.js %*
echo ================================================================
echo.
node release.js %*
set RC=!errorlevel!
echo.

if !RC! equ 0 (
  echo ================================================================
  echo   RELEASE OK
  echo   Site + APK live at https://odoreeci.tech/
  echo ================================================================
) else (
  echo ================================================================
  echo   RELEASE FAILED  ^(exit code !RC!^)
  echo   Read the errors above, fix them, and re-run.
  echo ================================================================
)

echo.
echo Press any key to close this window...
pause >nul
exit /b !RC!

:nope
echo.
echo Aborted — nothing was changed.
echo.
pause
endlocal
