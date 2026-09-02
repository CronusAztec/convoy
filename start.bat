@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 goto live

echo Node.js not found - starting SOLO mode (simulated riders)...
start "" "http://localhost:5173"
where py >nul 2>nul && (py -m http.server 5173) || (python -m http.server 5173)
goto :eof

:live
if not exist "server\node_modules" (
  echo First run - installing server dependency...
  pushd server
  call npm install --no-fund --no-audit
  popd
)
echo Starting Convoy LIVE server on http://localhost:5173 ...
start "" "http://localhost:5173"
node server\server.js
