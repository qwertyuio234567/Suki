@echo off
rem suki launcher: node server (render API + auto-open) -> python fallback -> pause on error
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
  echo node not found - starting plain python server (no render API)
  start "" http://localhost:8123/index.html
  python -m http.server 8123
  goto :end
)
echo Neither node nor python found. Install one of them:
echo   node: https://nodejs.org
echo   python: https://www.python.org/downloads/  (check "Add to PATH")
:end
echo.
pause
