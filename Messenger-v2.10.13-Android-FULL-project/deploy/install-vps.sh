#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запусти: sudo bash deploy/install-vps.sh"
  exit 1
fi
if [[ ! -f docker-compose.yml || ! -f Dockerfile || ! -f Caddyfile ]]; then
  echo "Не найдены файлы проекта. Перейди в корневую папку messenger-project и повтори запуск."
  exit 1
fi
if [[ ! -f /etc/os-release ]]; then echo "Не удалось определить Linux."; exit 1; fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
  echo "Рекомендуется Ubuntu 22.04/24.04 LTS или Debian 12. Текущая система: ${PRETTY_NAME:-unknown}"
  read -r -p "Продолжить установку Docker через официальный скрипт? [y/N] " confirm
  [[ "${confirm:-}" =~ ^[Yy]$ ]] || exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Устанавливаю Docker Engine и Compose..."
  apt-get update
  apt-get install -y ca-certificates curl python3
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi
systemctl enable --now docker
if ! command -v python3 >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3
fi

if [[ ! -f .env ]]; then
  read -r -p "Введи публичный IPv4-адрес этого VPS (домен не нужен): " server_ip
  server_ip="$(printf '%s' "$server_ip" | tr -d '[:space:]')"
  if ! python3 - "$server_ip" <<'PYIP'
import ipaddress, sys
try:
    ip = ipaddress.ip_address(sys.argv[1])
    if ip.version != 4 or not ip.is_global:
        raise ValueError('Нужен публичный глобальный IPv4')
except ValueError as e:
    print(f'Некорректный адрес: {e}', file=sys.stderr)
    sys.exit(1)
PYIP
  then
    echo "Укажи публичный IPv4 из панели VPS. Установка остановлена без запуска приложения."
    exit 1
  fi
  printf 'SERVER_IP=%s\n' "$server_ip" > .env
  chmod 600 .env
fi

SERVER_IP="$(sed -n 's/^SERVER_IP=//p' .env | head -n1 | tr -d '\r')"
if ! python3 - "$SERVER_IP" <<'PYIP'
import ipaddress, sys
try:
    ip = ipaddress.ip_address(sys.argv[1])
    if ip.version != 4 or not ip.is_global:
        raise ValueError('Нужен публичный глобальный IPv4')
except ValueError as e:
    print(f'Некорректный SERVER_IP в .env: {e}', file=sys.stderr)
    sys.exit(1)
PYIP
then
  echo "Исправь SERVER_IP в .env и запусти установщик повторно."
  exit 1
fi

mkdir -p backups data
chmod 700 backups
if [[ ! -s data/store.json && -s backend/data/store.json ]]; then
  echo "Найдена старая база backend/data/store.json — переношу её в data/store.json..."
  cp backend/data/store.json data/store.json
fi
chown -R 1000:1000 data
chmod 700 data

echo "Проверяю конфигурацию Docker Compose..."
docker compose config >/dev/null

echo "Собираю и запускаю мессенджер..."
docker compose up -d --build
sleep 3
docker compose ps

cat <<MSG

Контейнеры запущены. Адрес сервера: https://${SERVER_IP}
Проверка: https://${SERVER_IP}/api/health

ВАЖНО: HTTPS использует внутренний сертификат Caddy. Чтобы Electron/WebCrypto работали без предупреждений,
установи корневой сертификат Caddy на КАЖДОМ клиентском Windows-компьютере (инструкция в deploy/README-VPS-RU.md).
Не отправляй никому закрытые ключи Caddy и не копируй файлы *.key. Передавай только root.crt.

В панели VPS и в системном firewall разреши входящие TCP 22, 80 и 443.
Не открывай порт 3000 в интернет.

Команды управления:
  docker compose logs -f --tail=100
  docker compose ps
  docker compose restart
  docker compose up -d --build
  docker compose down

Резервная копия базы:
  docker compose exec -T app sh -c 'cat /data/store.json' > backups/store-\$(date +%F-%H%M%S).json

Это MVP, не прошедший независимый аудит безопасности. Не используй его для чувствительных данных без аудита.
MSG
