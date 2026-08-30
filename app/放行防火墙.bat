@echo off
title Allow LAN access to port 8080
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo  [ERROR] Please run this file AS ADMINISTRATOR.
  echo  Right-click this file, choose "Run as administrator".
  echo.
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="ClassScreen 8080" >nul 2>&1
netsh advfirewall firewall add rule name="ClassScreen 8080" dir=in action=allow protocol=TCP localport=8080
if %errorlevel% equ 0 (
  echo.
  echo  [OK] Port 8080 is now open for LAN devices.
  echo  Other phones / PCs on the same LAN can now open the control page.
  echo  Remember: phone must be on the SAME network as this machine.
  echo.
) else (
  echo.
  echo  [ERROR] Failed to add firewall rule.
  echo.
)
pause
