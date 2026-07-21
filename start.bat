@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "repo_root=%~dp0"
pushd "%repo_root%" >nul
set "pushd_exit=%errorlevel%"
if not "%pushd_exit%"=="0" goto repository_unavailable

echo ================================================
echo GitHub Copilot API Server
echo ================================================
echo.

if exist node_modules goto dependencies_ready

echo Installing dependencies...
setlocal
set "GH_TOKEN="
set "GITHUB_TOKEN="
bun install
set "install_exit=%errorlevel%"
endlocal & set "install_exit=%install_exit%"
if not "%install_exit%"=="0" goto install_failed
echo.

:dependencies_ready

echo Checking GitHub authentication...
bun run ./src/main.ts auth --_if-needed
set "auth_exit=%errorlevel%"
set "GH_TOKEN="
set "GITHUB_TOKEN="
if not "%auth_exit%"=="0" goto auth_failed
echo.

echo Starting server...
echo The hosted diagnostics dashboard will open automatically after the server starts
echo.

set "COPILOT_PROXY_START_REPOSITORY_ROOT=%CD%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" -AuthenticationPreflightCompleted
set "server_exit=%errorlevel%"

pause
popd
endlocal & exit /b %server_exit%

:install_failed
popd
endlocal & exit /b %install_exit%

:auth_failed
pause
popd
endlocal & exit /b %auth_exit%

:repository_unavailable
echo Failed to access the repository directory: %repo_root%
endlocal & exit /b %pushd_exit%
