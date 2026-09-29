@echo off
setlocal
call "%~dp0reelctl.cmd" mcp serve %*
exit /b %ERRORLEVEL%
