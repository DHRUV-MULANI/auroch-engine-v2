# Auto-start: dashboard + Cloudflare tunnel

Two **user-level** systemd services keep the site public across restarts:

- `auroch-app.service` — runs `npm run preview -- --host 0.0.0.0 --port 6001 --strictPort`.
- `auroch-tunnel.service` — runs cloudflared with the token for tunnel
  `c287e78f-7e9d-40a2-816e-a5f588a283e8`, which already has the public hostname
  `auroch.dhruvmulani.com` routed to `http://localhost:6001` in its dashboard ingress.
  It declares `Wants=`/`After=auroch-app.service` so the app is up first.

Both are enabled in `default.target.wants`, and user lingering is on
(`loginctl show-user boss -p Linger` → `Linger=yes`), so they start at boot without
a login session and restart automatically on failure (`Restart=always`).

Token lives at `~/.cloudflared/auroch.token` (mode 600). Never commit it.

Install / re-install:

```bash
TOKEN='...' ./deploy/install-auroch-tunnel.sh
```

Useful commands:

```bash
systemctl --user status auroch-app.service auroch-tunnel.service
systemctl --user restart auroch-app.service auroch-tunnel.service
journalctl --user -u auroch-tunnel.service -f
curl -sS -o /dev/null -w '%{http_code}\n' https://auroch.dhruvmulani.com/
```
