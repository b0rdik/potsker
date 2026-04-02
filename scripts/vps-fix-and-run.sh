#!/usr/bin/env bash
# Максимально просто — на сервере под root одна строка:
#   curl -fsSL https://raw.githubusercontent.com/b0rdik/potsker/main/scripts/vps-fix-and-run.sh | bash
# Если IP не угадался: DEPLOY_IP=1.2.3.4 curl -fsSL ... | bash
set -euo pipefail

REPO_DIR="/var/www/poker"

# Публичный IP для CORS и nginx (если не задан — спросим у интернета, иначе фиксированный запасной)
if [[ -z "${DEPLOY_IP:-}" ]]; then
  DEPLOY_IP="$(
    curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
      || curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
      || true
  )"
fi
if [[ -z "$DEPLOY_IP" ]]; then
  DEPLOY_IP="65.21.58.244"
fi

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запусти под root: sudo -i затем снова эту команду curl | bash"
  exit 1
fi

if ! id poker &>/dev/null; then
  adduser --disabled-password --gecos "" poker
fi

mkdir -p /var/www /var/lib/poker-data
chown poker:poker /var/www /var/lib/poker-data
chmod 750 /var/lib/poker-data

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Нет клона в $REPO_DIR — клонирую…"
  rm -rf "$REPO_DIR"
  sudo -u poker git clone https://github.com/b0rdik/potsker.git "$REPO_DIR"
fi

chown -R poker:poker "$REPO_DIR"
sudo -u poker bash -c "cd $REPO_DIR && git fetch origin && git checkout main && git pull --ff-only origin main"
sudo -u poker bash -c "cd $REPO_DIR && npm ci --omit=dev"

cat > /etc/systemd/system/poker.service << EOF
[Unit]
Description=Potsker
After=network.target

[Service]
Type=simple
User=poker
Group=poker
WorkingDirectory=$REPO_DIR
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=POKER_DATA_DIR=/var/lib/poker-data
Environment=SOCKET_IO_CORS_ORIGIN=http://${DEPLOY_IP}
Environment=AUTH_TOKEN_TTL_HOURS=168
ExecStart=/usr/bin/node $REPO_DIR/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

if [[ ! -f /etc/nginx/sites-enabled/poker ]]; then
  cat > /etc/nginx/sites-available/poker << NGINX_EOF
server {
    listen 80;
    server_name ${DEPLOY_IP};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_EOF
  ln -sf /etc/nginx/sites-available/poker /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

systemctl daemon-reload
systemctl enable poker
systemctl restart poker

sleep 1
if curl -sf -o /dev/null http://127.0.0.1:3000/; then
  echo "OK: http://127.0.0.1:3000 отвечает"
else
  echo "Ошибка запуска, лог:"
  journalctl -u poker -n 35 --no-pager
  exit 1
fi

systemctl --no-pager -l status poker || true
echo "Открой в браузере: http://${DEPLOY_IP}"
echo "Если UFW включён: ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable"
