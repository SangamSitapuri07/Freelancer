# Deployment guide

GhostGate is a single Node.js process with an embedded SQLite database and a static admin dashboard. It is designed to be easy to run on a small VPS, a container platform, or your own server.

## Requirements

- Node.js 22.5+ (for `node:sqlite`)
- A persistent disk for `DATA_DIR`
- HTTPS in production
- Outbound access to your AI provider

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | No | `8080` | HTTP port. |
| `HOST` | No | `0.0.0.0` | Bind address. |
| `DATA_DIR` | No | `./data` | Directory for SQLite and the pepper file. |
| `DB_PATH` | No | `./data/ghostgate.db` | SQLite database path. |
| `ADMIN_EMAIL` | First run | `admin@ghostgate.local` | Initial admin email. |
| `ADMIN_PASSWORD` | First run | `GhostGate!2026` | Initial admin password. Change it. |
| `ADMIN_NAME` | No | `Administrator` | Initial admin display name. |
| `HWID_PEPPER` | Recommended | auto-generated | Secret used to HMAC device IDs. Use 32+ random characters. |
| `SESSION_HOURS` | No | `24` | License session lifetime. |
| `ADMIN_SESSION_HOURS` | No | `12` | Admin session lifetime. |
| `CORS_ORIGIN` | No | empty | Comma-separated browser origins allowed to call the API. |
| `AI_BASE_URL` | No | Groq | OpenAI-compatible base URL. |
| `AI_API_KEY` | Yes for AI | empty | Server-side AI provider key. |
| `AI_MODEL` | No | `openai/gpt-oss-120b` | Model name. |
| `AI_TIMEOUT_MS` | No | `90000` | AI request timeout. |
| `AI_CREDITS_PER_REQUEST` | No | `1` | Base credit cost per AI request. |
| `AI_TOKENS_PER_CREDIT` | No | `1000` | Tokens per additional credit. |
| `AI_SYSTEM_PROMPT` | No | safe coding assistant | System prompt prepended to client messages. |
| `LOG_LEVEL` | No | `info` | Pino log level. |

## Generate secrets

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Use the output for `HWID_PEPPER`. Use a password manager for `ADMIN_PASSWORD` and `AI_API_KEY`.

## Docker

```bash
cp .env.example .env
# Edit .env
docker compose up -d --build
```

The compose file creates a named volume `ghostgate-data` mounted at `/app/data`. SQLite and the pepper file live there.

Check the health endpoint:

```bash
curl http://localhost:8080/v1/health
```

View logs:

```bash
docker compose logs -f ghostgate
```

Upgrade:

```bash
docker compose pull
docker compose up -d --build
```

Back up the volume:

```bash
docker run --rm -v ghostgate-data:/data -v "$PWD":/backup alpine \
  tar -czf /backup/ghostgate-data-$(date +%F).tar.gz -C /data .
```

## Reverse proxy with Caddy

Caddy can terminate TLS automatically.

```caddy
ghostgate.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Set `CORS_ORIGIN=https://your-client.example.com` if a browser client calls the API directly. For a desktop client, CORS is not needed.

## Reverse proxy with nginx

```nginx
server {
    listen 443 ssl http2;
    server_name ghostgate.example.com;

    ssl_certificate     /etc/letsencrypt/live/ghostgate.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ghostgate.example.com/privkey.pem;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Render

A `render.yaml` is included. It deploys the Node service with a persistent disk at `/var/data`.

1. Push the repository to GitHub.
2. Create a new Render Blueprint from `render.yaml`.
3. Set the secret environment variables:
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `HWID_PEPPER`
   - `AI_API_KEY`
4. Deploy.

The service exposes `/v1/health` for health checks.

## Backups

Back up the entire `DATA_DIR` directory. It contains:

- `ghostgate.db` — licenses, devices, sessions, usage, audit logs.
- `ghostgate.db-wal` — write-ahead log. Include it while the server is running, or stop the server before copying.
- `pepper.key` — the HWID pepper, if you did not set `HWID_PEPPER`.

Losing `pepper.key` or changing `HWID_PEPPER` changes the HMAC of every device ID. Existing devices will appear unbound. Store the pepper securely and back it up.

## Monitoring

- Watch `/v1/health`.
- Watch `docker compose logs` or your platform logs.
- Monitor `429` responses and failed activations.
- Review the audit log in the dashboard.
- Set up alerts for disk usage and process restarts.

## Security checklist

- [ ] HTTPS only.
- [ ] Strong `HWID_PEPPER`.
- [ ] Strong `ADMIN_PASSWORD`.
- [ ] `AI_API_KEY` only on the server.
- [ ] `CORS_ORIGIN` restricted.
- [ ] Persistent volume backed up.
- [ ] `NODE_ENV=production`.
- [ ] Dependencies updated.
- [ ] Firewall or private network for the server.
- [ ] Audit log reviewed regularly.

## Scaling

SQLite is single-node. If you need multiple server instances:

1. Move to PostgreSQL.
2. Replace `src/db.js` with a PostgreSQL client.
3. Use a shared database for licenses, devices, sessions, usage, and audit logs.
4. Use a distributed rate limiter (Redis) instead of the in-memory limiter.
5. Run multiple stateless instances behind a load balancer.

The current code is intentionally simple and portable. For a single operator and a small number of licenses, SQLite is sufficient.
