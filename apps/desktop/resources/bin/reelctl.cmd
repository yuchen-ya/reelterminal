@echo off
setlocal
set "APP_DIR=%~dp0"
if not exist "%APP_DIR%resources\app.asar" set "APP_DIR=%~dp0..\..\"
for %%I in ("%APP_DIR%") do set "APP_DIR=%%~fI"
if not exist "%APP_DIR%\ReelTerminal.exe" (
  >&2 echo ReelTerminal.exe was not found next to this reelctl launcher.
  exit /b 4
)
set "ELECTRON_RUN_AS_NODE=1"
"%APP_DIR%\ReelTerminal.exe" "%APP_DIR%\resources\app.asar\dist\reelctl\index.js" %*
exit /b %ERRORLEVEL%
