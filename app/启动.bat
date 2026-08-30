@echo off
title Classroom Screen Server (port 8080)
cd /d "%~dp0"
echo ==============================================
echo  Starting classroom screen server, port 8080
echo  Close this window to stop the server
echo ==============================================

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "D:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=D:\Program Files\nodejs\node.exe"
  ) else (
    echo [ERROR] node not found. Please install Node.js first.
    pause
    exit /b 1
  )
)

start "" "http://localhost:8080/screen.html"
"%NODE_EXE%" server.js
echo.
echo [ERROR] Server exited unexpectedly. Details above.
pause
