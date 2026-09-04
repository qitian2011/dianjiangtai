@echo off
chcp 65001 >nul
title 点将台 本地服务 (port 8080)
cd /d "%~dp0"

rem 访问密码来源：环境变量 DJT_PIN 优先，其次本目录 .djt_pin（不入源码包，不上 GitHub）
if not "%DJT_PIN%"=="" goto :has_pin
if exist ".djt_pin" goto :has_pin

echo ==============================================
echo  首次运行：请设置访问密码（防局域网名单裸奔）
echo  密码将保存到本目录 .djt_pin 文件
echo  （该文件不会随源码发布 / 上传 GitHub）
echo ==============================================
set /p NEWPIN=请输入访问密码后回车（直接回车 = 不设密码，服务将锁定名单接口）:
if "%NEWPIN%"=="" (
  echo.
  echo  [提示] 未设置密码：为避免名单裸奔，/api 与 /events 将被锁定(503)。
  echo  如需启用密码，请关闭本窗口后重新双击运行本脚本。
) else (
  > ".djt_pin" echo %NEWPIN%
  echo  密码已保存到 .djt_pin
)
goto :has_pin

:has_pin
if not "%DJT_PIN%"=="" (
  echo  访问密码：来自环境变量 DJT_PIN
) else if exist ".djt_pin" (
  echo  访问密码：来自 .djt_pin
) else (
  echo  ⚠️ 未配置访问密码：/api 与 /events 将被锁定（503，防名单裸奔）
)

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
