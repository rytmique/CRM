@echo off
REM ============================================================
REM  Agency CRM: бекап. Подвійний клік - копія всіх даних
REM  з сервера потрапить у папку backups поруч із цим файлом.
REM ============================================================
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Agency CRM - бекап

where ssh >nul 2>nul
if errorlevel 1 goto :no_ssh
set "SERVER_IP="
if exist "deploy-settings.txt" for /f "usebackq tokens=1,* delims==" %%a in ("deploy-settings.txt") do set "%%a=%%b"
if "%SERVER_IP%"=="" set /p "SERVER_IP=  IP сервера: "
if "%SERVER_IP%"=="" goto :eof

for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm"') do set "STAMP=%%d"
if not exist "backups" mkdir "backups"
set "OUT=backups\agency-backup-%STAMP%.tgz"

echo.
echo   Роблю бекап з %SERVER_IP% - ДВІЧІ спитає пароль сервера (root).
echo.
ssh -o StrictHostKeyChecking=accept-new root@%SERVER_IP% "cd /opt/agency-crm && docker compose stop app >/dev/null 2>&1; tar czf /root/agency-backup.tgz data; docker compose start app >/dev/null 2>&1"
if errorlevel 1 goto :failed
scp -o StrictHostKeyChecking=accept-new root@%SERVER_IP%:/root/agency-backup.tgz "%OUT%"
if errorlevel 1 goto :failed
for %%f in ("%OUT%") do if %%~zf LSS 1000 goto :failed
echo   Готово: %OUT%
echo.
pause
exit /b 0

:failed
del "%OUT%" >nul 2>nul
echo.
echo   [!] Бекап не вдався. Перевір IP і пароль сервера.
echo.
pause
exit /b 1

:no_ssh
echo.
echo   [!] У Windows немає ssh. Потрібна Windows 10 (2019+) або Windows 11.
echo.
pause
exit /b 1
