@echo off
REM ============================================================
REM  Agency CRM: подвійний клік запускає панель і відкриває браузер.
REM  Налаштування: файл .env поруч, приклад у .env.example
REM ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Agency CRM

where node >nul 2>nul
if errorlevel 1 goto :no_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto :old_node

if exist "node_modules\express\package.json" goto :deps_ok
echo.
echo   Перший запуск: встановлюю залежності, це хвилина...
call npm install --omit=dev --no-fund --no-audit
if errorlevel 1 goto :npm_failed
:deps_ok

set OPEN_BROWSER=1
echo.
echo   Запускаю панель Agency CRM...
node --disable-warning=ExperimentalWarning server\index.js
echo.
echo   Сервер зупинено.
pause
exit /b 0

:no_node
echo.
echo   [!] Не знайдено Node.js.
echo       Встановіть Node.js 22 LTS або новіший з https://nodejs.org
echo       і запустіть цей файл ще раз.
echo.
start "" https://nodejs.org/
pause
exit /b 1

:old_node
echo.
echo   [!] Застаріла версія Node.js:
node -v
echo       Потрібна 22.13 або новіша. Оновіть з https://nodejs.org
echo.
start "" https://nodejs.org/
pause
exit /b 1

:npm_failed
echo.
echo   [!] Не вдалося встановити залежності. Перевірте інтернет і запустіть ще раз.
echo.
pause
exit /b 1
