# Tunnel Setup — one public HTTPS/WSS endpoint

The Flutter app (any cellular / Wi‑Fi network) and the warden dashboard (any
other Wi‑Fi) reach the backend through a single public HTTPS endpoint — a
Cloudflare Tunnel (quick or named) or Tailscale Funnel. The API binds
`0.0.0.0`, so the tunnel connects to it on `localhost:3001` without
any router port‑forwarding.

> **Never commit a tunnel URL or `~/.cloudflared/*`.** The URL goes in `.env`
> files only (all git‑ignored). The credentials JSON gives full control of
> the tunnel.

## 0. Install cloudflared

| OS | Command |
|---|---|
| Windows | `winget install --id Cloudflare.cloudflared` — or drop `cloudflared-windows-amd64.exe` into the git‑ignored `.tools/` folder as `.tools/cloudflared.exe` |
| macOS | `brew install cloudflared` |
| Debian/Ubuntu | see <https://pkg.cloudflare.com/> |

```bash
cloudflared --version
```

## 1. Smoke test — quick tunnel (no account, URL changes every run)

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:3001
# prints: https://<random-words>.trycloudflare.com
```

Use that URL as `$API` (below). Quick tunnels are for smoke tests only: the
hostname changes on every start and there is no uptime guarantee.

## 1b. Tailscale Funnel — stable hostname, no domain (recommended when you have no domain)

A quick tunnel rotates its hostname on every restart, so any client with the
URL baked in (the APK) breaks. Tailscale Funnel gives a **stable**
`https://<machine>.<tailnet>.ts.net` hostname with a real certificate, free,
and it survives reboots because the tunnel is served by the `tailscaled`
service rather than a foreground process.

```bash
winget install --id Tailscale.Tailscale --exact
tailscale up                     # follow the printed login URL
```

Two tailnet switches must be on before Funnel will start (both are one-time):

1. **HTTPS certificates** — <https://login.tailscale.com/admin/dns>
2. **Funnel** — `tailscale funnel --bg 8080` prints an
   `https://login.tailscale.com/f/funnel?node=...` link when it is off; open
   it, or use <https://login.tailscale.com/admin/settings/funnel>

Then expose nginx, not a single API port, so the three instances and the
WebSocket upgrade all stay behind the same front door:

```bash
tailscale funnel --bg 8080       # https://<machine>.<tailnet>.ts.net -> 127.0.0.1:8080
tailscale funnel status
```

Find the hostname for the clients:

```bash
tailscale status --json | jq -r '.Self.DNSName'   # trailing dot is normal
```

Notes:

- Funnel listens on **443, 8443 and 10000** only; `--https=443` is the default.
- WebSocket upgrades pass through unchanged, so `transports: ['websocket']`
  keeps working.
- The serve config is stored by `tailscaled`, so it comes back after a reboot
  with no command to re-run. `tailscale funnel --https=443 off` disables it.
- Funnel is public: anyone with the URL reaches `:8080`. Keep the API's auth,
  rate limiting and CORS allowlist as they are — the hostname is not a secret.

## 2. Named tunnel — stable hostname (requires a domain on Cloudflare)


```bash
cloudflared tunnel login                         # browser auth, writes ~/.cloudflared/cert.pem
cloudflared tunnel create hostelguard            # writes ~/.cloudflared/<TUNNEL_ID>.json
cloudflared tunnel route dns hostelguard api.yourdomain.com
```

`~/.cloudflared/config.yml` (Windows: `%USERPROFILE%\.cloudflared\config.yml`):

```yaml
tunnel: hostelguard
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json   # Windows: C:\Users\<user>\.cloudflared\<TUNNEL_ID>.json

ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:3001     # single instance (or http://localhost:8080 for nginx)
  - service: http_status:404
```

Cloudflare proxies WebSocket upgrades by default — no extra setting is
needed for `transports: ['websocket']`.

```bash
cloudflared tunnel ingress validate
cloudflared tunnel run hostelguard
```

### Keep it running under PM2

```bash
pm2 start cloudflared --name tunnel -- tunnel --no-autoupdate run hostelguard
pm2 save
```

## 2b. Front the API with nginx (recommended)

Point the tunnel at nginx instead of a single API port. One ingress, all
three PM2 instances behind it, WebSocket upgrade and REST failover both work
through the tunnel:

```bash
# Windows (Git Bash). Any nginx 1.29+ works.
NGX="$LOCALAPPDATA/Microsoft/WinGet/Packages/nginxinc.nginx_Microsoft.Winget.Source_8wekyb3d8bbwe/nginx-1.31.8/nginx.exe"
mkdir -p .tools/nginx/logs .tools/nginx/temp
"$NGX" -p "$(pwd -W)/.tools/nginx/" -c "$(pwd -W)/backend/nginx.conf" -g "daemon off;"

./.tools/cloudflared.exe tunnel --no-autoupdate --url http://localhost:8080
```

`backend/nginx.conf` round-robins 3001/3002/3003 on :8080 with
`proxy_next_upstream error timeout http_503`, so killing one instance keeps
dashboards `Live` and REST calls return 201 via a survivor. Without nginx the
tunnel pins a single instance and those two guarantees do not hold.

`app.set('trust proxy', 1)` in `src/app.ts` matches this single proxy hop, so
rate limiters keep keying on the real client IP from `X-Forwarded-For`.

## 3. Point the clients at the tunnel

| Where | Setting |
|---|---|
| `backend/.env` | `PUBLIC_API_URL=https://api.yourdomain.com` (reference), `DASHBOARD_ORIGIN=<dashboard origin if hosted>` |
| `warden-dashboard/.env` | `VITE_API_URL=https://api.yourdomain.com` (restart `npm run dev` after changing) |
| Flutter | `flutter run --dart-define=API_BASE_URL=https://api.yourdomain.com` |

With Tailscale Funnel (§1b) the two values are
`https://<machine>.<tailnet>.ts.net` — the same string in both places.

The dashboard served from `http://localhost:5173` / `http://127.0.0.1:5173`
is already in the CORS allowlist. A dashboard served from any other origin
must be listed in `DASHBOARD_ORIGIN` (or `CORS_ORIGIN`), then restart the API.

## 4. Verify

```bash
API=https://api.yourdomain.com     # or the trycloudflare URL

curl -s -o /dev/null -w "health=%{http_code}\n" "$API/health"
# expect: health=200

curl -i "$API/socket.io/?EIO=4&transport=websocket" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  --max-time 5 | head -5
# expect: HTTP/1.1 101 Switching Protocols
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `502 Bad Gateway` from Cloudflare | API not running, or bound to `127.0.0.1` on a different interface — check `netstat -ano \| findstr 3001` shows `0.0.0.0:3001` |
| Browser console: CORS blocked | Dashboard origin not in the allowlist — set `DASHBOARD_ORIGIN`, restart the API |
| `connect_error: websocket error` on the dashboard | `VITE_API_URL` still points at an old quick‑tunnel URL — they change every run |
| Quick tunnel URL stopped working | Expected — restart and update both `.env` files, or use a named tunnel |
| `Funnel is not enabled on your tailnet` | Open the printed `login.tailscale.com/f/funnel` link, and enable HTTPS certificates under **DNS** |
| Funnel returns 502 | nginx is down — `netstat -ano \| findstr :8080` should show a listener; restart nginx |
| Funnel URL changed | It doesn't — `ts.net` names are stable. If it did, the node was removed/re-added: re-read `.Self.DNSName` |
