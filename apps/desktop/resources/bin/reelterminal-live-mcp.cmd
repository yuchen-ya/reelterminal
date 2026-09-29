@echo off
setlocal
call "%~dp0reelctl.cmd" mcp serve --compat %*
exit /b %ERRORLEVEL%
