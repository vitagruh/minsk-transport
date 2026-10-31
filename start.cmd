@echo off
setlocal
chcp 65001 >nul
title Транспорт Минска
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден.
  echo Установите Node.js 20 или новее: https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 20 (
  echo Нужен Node.js 20 или новее. Установленная версия:
  node -v
  pause
  exit /b 1
)

if not defined PORT set "PORT=3000"
if /i "%~1"=="lan" (
  set "HOST=0.0.0.0"
) else if not defined HOST (
  set "HOST=127.0.0.1"
)

if /i "%~1"=="lan" (
  echo Режим локальной сети. Адреса этого компьютера:
  ipconfig | findstr /i "IPv4"
  echo Разрешите Node.js доступ в брандмауэре Windows для частных сетей.
  echo.
) else (
  echo Локальный адрес: http://127.0.0.1:%PORT%
)
echo Остановка: Ctrl+C
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"
node server.js
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Сервер завершился с кодом %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
