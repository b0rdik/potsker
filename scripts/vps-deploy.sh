#!/usr/bin/env bash
# Вызывается на VPS после git pull: npm ci и перезапуск процесса.
# Репозиторий должен лежать в каталоге приложения (рядом с package.json).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NODE_ENV="${NODE_ENV:-production}"
npm ci --omit=dev

if [[ -n "${SYSTEMD_SERVICE:-}" ]] && command -v systemctl >/dev/null 2>&1; then
  sudo -n systemctl restart "$SYSTEMD_SERVICE"
elif command -v pm2 >/dev/null 2>&1; then
  pm2 restart poker 2>/dev/null || pm2 start server.js --name poker
else
  echo "Укажи SYSTEMD_SERVICE=имя_юнита или установи pm2, либо перезапусти node вручную."
  exit 1
fi
