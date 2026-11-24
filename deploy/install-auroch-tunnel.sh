#!/usr/bin/env bash
# Install the Auroch dashboard + Cloudflare tunnel as persistent USER systemd services.
# Both are enabled for automatic startup on login/reboot (user lingering is already on).
# Usage: TOKEN='eyJ...' ./deploy/install-auroch-tunnel.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${TOKEN:?Set TOKEN to the auroch tunnel token from Cloudflare Zero Trust dashboard}"

install -d -m 700 "$HOME/.cloudflared"
printf '%s\n' "$TOKEN" > "$HOME/.cloudflared/auroch.token"
chmod 600 "$HOME/.cloudflared/auroch.token"

install -d -m 700 "$HOME/.config/systemd/user"
for unit in auroch-app.service auroch-tunnel.service; do
  cp "$ROOT/deploy/$unit" "$HOME/.config/systemd/user/$unit"
done

systemctl --user daemon-reload
systemctl --user enable --now auroch-app.service
systemctl --user enable --now auroch-tunnel.service

echo "=== Service status ==="
systemctl --user --no-pager status auroch-app.service auroch-tunnel.service | head -30
echo
echo "=== Local check ==="
curl -sS -o /dev/null -w 'http://localhost:6001 -> HTTP %{http_code}\n' http://localhost:6001/ || true
echo "=== Public check ==="
curl -sS -o /dev/null -w 'https://auroch.dhruvmulani.com -> HTTP %{http_code}\n' https://auroch.dhruvmulani.com/ || true
