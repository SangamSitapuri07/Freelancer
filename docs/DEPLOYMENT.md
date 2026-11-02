# Deploying the Rust control server

## Requirements

- Rust stable if building directly, or Docker.
- A **persistent disk** for SQLite. Do not use an ephemeral/serverless filesystem.
- HTTPS in production, terminated by a reverse proxy you control.
- One server instance per SQLite database. This design is intentionally single-writer/single-instance; use Postgres and a shared rate limiter before horizontal scaling.

## Configure

```bash
cargo run -p ghost-control-server --bin gen-secrets
cp server/.env.example server/.env
```

Set:

- `ADMIN_PASSWORD` — long unique owner password.
- `CODE_PEPPER` — 64 hex characters, generated once. Back it up. Changing it invalidates all existing registration codes.
- `GROQ_API_KEY` — server-only provider key.
- `PUBLIC_ORIGIN` — production HTTPS origin, e.g. `https://ghostai.example.com`.
- `GHOST_ENV=production`.
- `TRUST_PROXY=true` only when exactly one trusted reverse proxy overwrites/appends `X-Forwarded-For`.
- `DB_PATH` — persistent path, e.g. `/data/ghostai.sqlite`.

Optional quota/provider settings are listed in `server/.env.example`.

## Docker Compose

```bash
docker compose -f deploy/compose.yml up -d --build
```

The container listens on `0.0.0.0:8787`; Compose publishes it only to host loopback. Put Caddy/nginx/Traefik in front for HTTPS and forward to `127.0.0.1:8787`. The SQLite volume is `ghost-control-data`.

## Direct build

```bash
cargo build --release -p ghost-control-server
./target/release/ghost-control-server
```

Run it under systemd or your platform's process manager. Back up the SQLite database **and** `CODE_PEPPER`.

## Reverse proxy checklist

- TLS certificate and HTTPS redirect.
- Forward `Host` and `X-Forwarded-For`; do not trust client-supplied forwarding headers unless the proxy overwrites them.
- Request body limit at least the server's `MAX_IMAGE_BYTES × MAX_IMAGES × 4/3 + 128 KiB`.
- Keep `/admin` private to the owner where possible (VPN, IP allowlist, or proxy auth in addition to the app password).
- Do not cache `/admin` or `/v1/*`.

## Create and distribute access

1. Sign in to `/admin`.
2. Create a license with token and request limits.
3. Copy the eight-digit code shown once.
4. Package the Windows client with your HTTPS `server_url`.
5. Send the ZIP and code through separate channels if possible.
6. Use **Reset device** when a user changes machines; use **Revoke** to stop access.

## Uncertain requests

Timeouts, interrupted responses, missing provider usage, and process crashes can leave a request whose provider cost is unknown. The server holds the reserved tokens/request against the allowance. Review Groq's dashboard/logs, then use **Release hold** if no charge occurred or **Keep charge** if it did.
