#!/usr/bin/env bash
# Install or update the StumbleChat automod on a Linux server (run as root).
#
#   curl -fsSL https://raw.githubusercontent.com/deathdopest-sketch/meatspace-automod/main/deploy/hetzner/install.sh | bash
#   # or, from a checkout: bash deploy/hetzner/install.sh
#
# Safe to re-run: it pulls the latest code and reinstalls dependencies.
set -euo pipefail

APP_DIR=/opt/meatspace-automod
REPO=https://github.com/deathdopest-sketch/meatspace-automod.git
BRANCH="${AUTOMOD_BRANCH:-main}"
NODE=/usr/local/bin/node
export PUPPETEER_CACHE_DIR="$APP_DIR/.cache/puppeteer"

log() { printf '\n[automod-install] %s\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found; install Node.js 18+ first" >&2; exit 1; }

log "system packages"
apt-get update -qq
apt-get install -y -qq git xvfb xauth fonts-liberation fonts-noto-color-emoji >/dev/null

log "service user"
id automod >/dev/null 2>&1 || useradd --system --home /var/lib/stumble-automod --shell /usr/sbin/nologin automod
install -d -o automod -g automod -m 750 /var/lib/stumble-automod
install -d -m 750 /etc/stumble-automod

log "code ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

log "dependencies and Chrome"
cd "$APP_DIR"
"$(dirname "$NODE")/npm" ci --omit=dev --no-audit --no-fund --loglevel=error
# Puppeteer's Chrome plus the system libraries it needs
"$(dirname "$NODE")/npx" --yes puppeteer browsers install chrome --install-deps
chown -R automod:automod "$APP_DIR/.cache"

log "systemd unit"
sed "s#/usr/local/bin/node#$NODE#" deploy/hetzner/stumble-automod@.service > /etc/systemd/system/stumble-automod@.service
systemctl daemon-reload

running=$(systemctl list-units --type=service --state=running --no-legend 'stumble-automod@*' | awk '{print $1}')
if [ -n "$running" ]; then
  log "restarting: $running"
  systemctl restart $running
fi

cat <<MSG

Installed. To add a bot for a room:
  cp $APP_DIR/deploy/hetzner/instance.env.example /etc/stumble-automod/meatspace.env
  chmod 600 /etc/stumble-automod/meatspace.env
  nano /etc/stumble-automod/meatspace.env      # bot login, nick, room
  systemctl enable --now stumble-automod@meatspace
  journalctl -u stumble-automod@meatspace -f   # watch it log in
MSG
