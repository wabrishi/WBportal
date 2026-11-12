#!/usr/bin/env bash
# One-command installer for a fresh Hostinger KVM VPS (Ubuntu 22.04 / 24.04).
# Installs Node.js 22, pm2, nginx, free HTTPS (Let's Encrypt), firewall, daily backups,
# and runs the app as a service that restarts on crash and on reboot.
#
#   Upload the project folder to the VPS (or git clone it), then from inside it run:
#     sudo bash scripts/install-vps.sh yourdomain.com you@email.com
#
#   Updating later:  sudo bash scripts/install-vps.sh --update
set -euo pipefail

APP_USER=wa
APP_DIR=/home/$APP_USER/app
STORAGE=/home/$APP_USER/storage
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { echo -e "\n\033[1;32m==> $*\033[0m"; }
die() { echo -e "\033[1;31mError: $*\033[0m" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -f "$SRC_DIR/server.js" ] || die "run this from inside the project folder"

copy_app() {
  say "Copying the app to $APP_DIR"
  mkdir -p "$APP_DIR"
  rsync -a --delete --exclude node_modules --exclude data --exclude sessions --exclude storage \
    --exclude deploy --exclude .git --exclude .env "$SRC_DIR"/ "$APP_DIR"/
  chown -R $APP_USER:$APP_USER "$APP_DIR"
  sudo -u $APP_USER bash -c "cd $APP_DIR && npm ci --omit=dev --no-audit --no-fund"
}

if [ "${1:-}" = "--update" ]; then
  copy_app
  # --update only restarts the app; if you changed PORT in .env, run the full install again so nginx follows
  sudo -u $APP_USER pm2 restart wa-saas --update-env
  say "Updated and restarted."
  exit 0
fi

DOMAIN="${1:-}"; EMAIL="${2:-}"
[ -n "$DOMAIN" ] || read -rp "Your domain (e.g. app.yourbrand.com): " DOMAIN
[ -n "$EMAIL" ] || read -rp "Your email (for HTTPS certificate notices): " EMAIL
[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || die "domain and email are required"

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg nginx certbot python3-certbot-nginx rsync ufw cron
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2@latest

say "Creating user '$APP_USER'"
id $APP_USER >/dev/null 2>&1 || adduser --disabled-password --gecos "" $APP_USER
mkdir -p "$STORAGE" /home/$APP_USER/backups
chown -R $APP_USER:$APP_USER "$STORAGE" /home/$APP_USER/backups

copy_app

if [ ! -f "$APP_DIR/.env" ]; then
  say "Creating .env"
  SETUP_KEY=$(openssl rand -hex 12)
  CRON_KEY=$(openssl rand -hex 16)
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i '/^SUPERADMIN_EMAIL=/d; /^SUPERADMIN_PASSWORD=/d' "$APP_DIR/.env"
  cat >> "$APP_DIR/.env" <<EOF

# --- set by install-vps.sh ---
STORAGE_DIR=$STORAGE
SETUP_KEY=$SETUP_KEY
CRON_KEY=$CRON_KEY
EOF
  chown $APP_USER:$APP_USER "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
fi
# keep the existing .env (and its keys) on re-runs
SETUP_KEY=$(grep -E '^SETUP_KEY=' "$APP_DIR/.env" | cut -d= -f2-)
# the port the app listens on (PORT in .env, default 3000) — nginx must forward to the same port
PORT=$(grep -E '^PORT=' "$APP_DIR/.env" | tail -1 | cut -d= -f2- | tr -dc '0-9')
PORT=${PORT:-3000}

say "Starting the app with pm2"
sudo -u $APP_USER bash -c "cd $APP_DIR && (pm2 describe wa-saas >/dev/null 2>&1 && pm2 restart wa-saas || pm2 start server.js --name wa-saas --time) && pm2 save"
env PATH="$PATH" pm2 startup systemd -u $APP_USER --hp /home/$APP_USER >/dev/null

say "Configuring nginx for $DOMAIN"
cat > /etc/nginx/sites-available/wa-saas <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/wa-saas /etc/nginx/sites-enabled/wa-saas
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

say "Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

say "HTTPS certificate"
if certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect; then
  URL="https://$DOMAIN"
else
  echo "Could not get a certificate yet. Make sure the domain's A record points to this server's IP, then run:"
  echo "  sudo certbot --nginx -d $DOMAIN -m $EMAIL --agree-tos --redirect"
  URL="http://$DOMAIN"
fi

say "Daily backups (02:30, kept 14 days, in /home/$APP_USER/backups)"
cat > /etc/cron.d/wa-saas-backup <<EOF
30 2 * * * $APP_USER tar czf /home/$APP_USER/backups/wa-\$(date +\%F).tgz -C /home/$APP_USER storage && find /home/$APP_USER/backups -name 'wa-*.tgz' -mtime +14 -delete
EOF

say "Done!"
cat <<EOF

  Your platform:     $URL
  Super admin setup: $URL/admin      (setup key: $SETUP_KEY)
  Customer signup:   $URL/signup

  Logs:     sudo -u $APP_USER pm2 logs wa-saas
  Restart:  sudo -u $APP_USER pm2 restart wa-saas
  Update:   upload the new version, then: sudo bash scripts/install-vps.sh --update
  Data:     $STORAGE   (backups in /home/$APP_USER/backups)

EOF
