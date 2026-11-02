#!/usr/bin/env bash
# Agency CRM — installs or updates the panel on an Ubuntu/Debian server.
# Normally started by deploy.bat from Windows; can also be run by hand:  bash install.sh
# Settings come from setup.env (written by deploy.bat) and are kept in .env between runs.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n  %s\n' "$*"; }
fail() { printf '\n  [!] %s\n\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || fail "Запустіть від root (або через sudo)."

set_env() {  # set_env KEY VALUE — replace or add a line in .env
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
get_env() { grep "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

# ---------- 1. Docker ----------
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  say "Встановлюю Docker (2–3 хвилини)…"
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || fail "Не вдалося встановити Docker. Перевірте, що це Ubuntu або Debian."
fi

# ---------- 2. Settings ----------
touch .env
if [ -f setup.env ]; then
  sed -i 's/\r$//' setup.env
  while IFS='=' read -r key value; do
    key="$(echo "$key" | tr -d '[:space:]')"
    value="$(echo "$value" | sed 's/^ *//; s/ *$//')"
    [ -z "$key" ] || [ -z "$value" ] && continue   # empty answer = keep what was there
    set_env "$key" "$value"
  done < setup.env
  rm -f setup.env
fi

DOMAIN="$(get_env DOMAIN)"
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "panel.example.com" ]; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  [ -n "$IP" ] || fail "Не вдалося визначити IP сервера. Вкажіть домен."
  DOMAIN="${IP//./-}.sslip.io"
  say "Домен не вказано — використовую безкоштовну адресу $DOMAIN"
fi
set_env DOMAIN "$DOMAIN"
set_env PUBLIC_URL "https://$DOMAIN"
[ -n "$(get_env DEMO_SITE)" ] || set_env DEMO_SITE 0
chmod 600 .env

# ---------- 3. Firewall (if enabled) ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi

# ---------- 4. Start ----------
say "Збираю і запускаю панель (перший раз — кілька хвилин)…"
docker compose up -d --build >/tmp/agency-build.log 2>&1 || { tail -n 30 /tmp/agency-build.log; fail "Збірка не вдалася (лог вище)."; }

say "Чекаю, поки панель запуститься…"
ok=""
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { docker compose logs app --tail 30; fail "Панель не запустилась (лог вище)."; }

say "Отримую HTTPS-сертифікат для $DOMAIN…"
https=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 -o /dev/null "https://$DOMAIN/api/health"; then https=1; break; fi
  sleep 4
done

# ---------- 5. Result ----------
ADMIN_EMAIL="$(get_env ADMIN_EMAIL)"
LOGIN_NOTE="Пароль:  той, що ви вводили під час установки"
if [ -z "$(get_env ADMIN_PASSWORD)" ] && [ -f data/admin-login.txt ]; then
  LOGIN_NOTE="Пароль:  $(tr -d '\r' < data/admin-login.txt | grep 'пароль' | sed 's/.*: *//')"
fi
# The admin password is only needed for the very first start — don't keep it on disk.
sed -i '/^ADMIN_PASSWORD=/d' .env

echo
echo "  ================================================================"
if [ -n "$https" ]; then
  echo "   ГОТОВО! Панель працює:  https://$DOMAIN"
else
  echo "   Панель запущена, але HTTPS ще не готовий."
  echo "   Спробуйте за 5 хвилин:  https://$DOMAIN"
  echo "   Якщо не відкриється — перевірте, що домен вказує на IP сервера"
  echo "   і що у хостингу відкриті порти 80 і 443."
fi
echo
echo "   Логін:   ${ADMIN_EMAIL:-admin@local}"
echo "   $LOGIN_NOTE"
echo
echo "   Далі в панелі: Агенції → + Нова агенція"
echo "  ================================================================"
echo
