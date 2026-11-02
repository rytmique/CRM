@echo off
REM ============================================================
REM  Agency CRM: установка або оновлення панелі на сервері.
REM  Подвійний клік і 5 питань. Потрібен сервер з Ubuntu:
REM  IP і пароль root дає хостинг після покупки.
REM ============================================================
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Agency CRM - установка на сервер

where ssh >nul 2>nul
if errorlevel 1 goto :no_ssh
where tar >nul 2>nul
if errorlevel 1 goto :no_ssh

set "SERVER_IP="
set "PANEL_DOMAIN="
if exist "deploy-settings.txt" for /f "usebackq tokens=1,* delims==" %%a in ("deploy-settings.txt") do set "%%a=%%b"

echo.
echo   ==============================================
echo    Agency CRM: установка панелі на сервер
echo   ==============================================
echo.
if "%SERVER_IP%"=="" goto :ask_new
echo   Минулого разу ставили на сервер %SERVER_IP%
set "ANSWER="
set /p "ANSWER=  Оновити його? Enter - так, n - інший сервер: "
if /i "%ANSWER%"=="n" goto :ask_new
set "ADMIN_EMAIL="
set "ADMIN_PASSWORD="
set "CLAUDE_KEY="
set "MODE=update"
goto :pack

:ask_new
set "MODE=install"
echo   Пароль і ключ - лише латинські літери, цифри, знаки - і _
echo.
:ask_ip
set "SERVER_IP="
set /p "SERVER_IP=  1/5  IP сервера (з листа хостингу): "
if "%SERVER_IP%"=="" goto :ask_ip
set "PANEL_DOMAIN="
set /p "PANEL_DOMAIN=  2/5  Твій домен, напр. panel.site.com (немає - просто Enter): "
:ask_email
set "ADMIN_EMAIL="
set /p "ADMIN_EMAIL=  3/5  Email для входу в панель: "
if "%ADMIN_EMAIL%"=="" goto :ask_email
:ask_pass
set "ADMIN_PASSWORD="
set /p "ADMIN_PASSWORD=  4/5  Придумай пароль для панелі, мінімум 8 символів: "
if "%ADMIN_PASSWORD%"=="" goto :ask_pass
if "%ADMIN_PASSWORD:~7,1%"=="" (
  echo        Закороткий, треба мінімум 8 символів.
  goto :ask_pass
)
set "CLAUDE_KEY="
set /p "CLAUDE_KEY=  5/5  Ключ Claude sk-ant-... (немає - Enter, додаси потім у панелі): "
> "deploy-settings.txt" echo SERVER_IP=%SERVER_IP%
>> "deploy-settings.txt" echo PANEL_DOMAIN=%PANEL_DOMAIN%

:pack
echo.
echo   Пакую файли...
> "setup.env" echo DOMAIN=%PANEL_DOMAIN%
>> "setup.env" echo ADMIN_EMAIL=%ADMIN_EMAIL%
>> "setup.env" echo ADMIN_PASSWORD=%ADMIN_PASSWORD%
>> "setup.env" echo ANTHROPIC_API_KEY=%CLAUDE_KEY%
set "PKG=%TEMP%\agency-crm-deploy.tgz"
tar -czf "%PKG%" server web extension demo-site package.json package-lock.json Dockerfile docker-compose.yml Caddyfile install.sh setup.env
set "TAR_ERR=%errorlevel%"
del "setup.env" >nul 2>nul
if not "%TAR_ERR%"=="0" goto :pack_failed

echo.
echo   Далі кілька разів спитає пароль від СЕРВЕРА (root).
echo   Під час введення символи не видно - це нормально, просто введи і Enter.
if "%MODE%"=="update" goto :upload
echo.
echo   Спершу перевіряю вхід. Якщо сервер новий, він попросить ЗМІНИТИ пароль:
echo     1) введи пароль з листа,  2) ще раз його ж,  3) двічі новий пароль.
echo   Запам'ятай новий пароль - далі вводь саме його.
echo.
ssh -t -o StrictHostKeyChecking=accept-new root@%SERVER_IP% "echo   Вхід на сервер працює."

:upload
echo.
scp -o StrictHostKeyChecking=accept-new "%PKG%" root@%SERVER_IP%:/root/agency-crm-deploy.tgz
if errorlevel 1 goto :upload_failed
ssh -t -o StrictHostKeyChecking=accept-new root@%SERVER_IP% "mkdir -p /opt/agency-crm && tar xzf /root/agency-crm-deploy.tgz -C /opt/agency-crm && rm -f /root/agency-crm-deploy.tgz && sed -i 's/\r$//' /opt/agency-crm/install.sh && bash /opt/agency-crm/install.sh"
if errorlevel 1 goto :install_failed
del "%PKG%" >nul 2>nul
echo.
echo   Адресу і логін видно вище. Відкрий адресу в браузері.
echo.
pause
exit /b 0

:no_ssh
echo.
echo   [!] У Windows немає ssh або tar. Потрібна Windows 10 (2019+) або Windows 11.
echo       Налаштування - Програми - Додаткові компоненти - додай "Клієнт OpenSSH".
echo.
pause
exit /b 1

:pack_failed
echo.
echo   [!] Не вдалося запакувати файли. Запусти deploy.bat з папки agency-crm.
echo.
pause
exit /b 1

:upload_failed
echo.
echo   [!] Не вдалося підключитися до сервера.
echo       Перевір IP і пароль root. Сервер має бути з Ubuntu і вже запущений.
echo.
pause
exit /b 1

:install_failed
echo.
echo   [!] Установка на сервері не завершилась - причина написана вище.
echo       Скопіюй текст з цього вікна і надішли розробнику.
echo.
pause
exit /b 1
