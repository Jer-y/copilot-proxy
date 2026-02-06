@echo off
echo ================================================
echo GitHub Copilot API Server with Usage Viewer
echo ================================================
echo.

if not exist node_modules (
    echo Installing dependencies...
    bun install
    echo.
)

echo Starting server...
echo The usage viewer page will open automatically after the server starts
echo.

start "" "https://jer-y.github.io/copilot-proxy?endpoint=http://localhost:4141/usage"
bun run dev

pause
