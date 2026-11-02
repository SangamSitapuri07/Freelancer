# GhostGate

**Self-hosted license, device-binding, credit-control, and AI-proxy server for legitimate software.**

GhostGate is the control plane for a shareable client application. You issue license keys, bind them to devices, set credit and token limits, revoke access, and keep your AI provider key on the server. The client never contains the AI key and cannot mint its own credits.

> **Scope note:** This branch replaces the previous GhostAI exam-automation code. I did not build or improve the exam overlay, capture-exclusion stealth, global keyboard hook, panic mode, or answer-typing automation. Those features are designed to defeat exam monitoring, so they are not part of this project. The old code remains in Git history for reference, but it is not part of this branch.

---

## What you get

- **License keys** with 80 bits of entropy, stored as SHA-256 hashes.
- **Hardware binding** using an HMAC-SHA256 device fingerprint with a server-side pepper.
- **Device limits** with admin unbinding and self-service release.
- **Credit accounting** with a server-side ledger and per-request token cost.
- **Per-license limits** for devices, max tokens per request, requests per minute, and expiry.
- **Server-side AI proxy** so the provider key never ships to the client.
- **Admin dashboard** for licenses, devices, credits, usage, audit logs, and settings.
- **Opaque session tokens** stored hashed, with short expiry and instant revocation.
- **Audit trail** for admin actions and license events.
- **Rate limits** for activation, AI requests, and admin login.
- **Docker and Node.js deployment** with a release zip.
- **Test suite** covering the full license lifecycle.

## What this is not

- It is **not** an exam tool. It does not capture screens, hide windows from capture, intercept keys, or type answers.
- It is **not** a DRM guarantee. Client code can always be modified. The server is the source of truth for credits, devices, and AI access.
- It is **not** a multi-tenant SaaS by default. It is a single-tenant control plane for one operator. SQLite is used for a simple, portable deployment.

---

## Architecture

```
┌────────────────────┐        HTTPS         ┌──────────────────────────┐
│  Your client app   │ ───────────────────▶ │  GhostGate server        │
│  (desktop, CLI,    │ ◀─────────────────── │  Fastify + SQLite        │
│   web, etc.)       │   session + credits  │                          │
└────────────────────┘                      │  ┌────────────────────┐  │
                                            │  │ Admin dashboard    │  │
                                            │  └────────────────────┘  │
                                            │  ┌────────────────────┐  │
                                            │  │ AI proxy           │  │ ──▶ AI provider
                                            │  │ (key server-side)  │  │
                                            │  └────────────────────┘  │
                                            └──────────────────────────┘
```

The client calls:

1. `POST /v1/licenses/activate` with a license key and device ID.
2. `POST /v1/ai/completions` with a session token and text messages.
3. `GET /v1/license` or `POST /v1/license/heartbeat` to check status.

The server enforces the license, device, credit, and rate limits before it calls the AI provider.

---

## Quick start (Node.js)

Requirements: **Node.js 22.5+** (for the built-in `node:sqlite` module).

```bash
npm install
cp .env.example .env
# Edit .env: set ADMIN_PASSWORD, HWID_PEPPER, and AI_API_KEY.
npm start
```

Open **http://localhost:8080** and sign in with the admin credentials from `.env`.

On first start, if the `admins` table is empty, GhostGate creates the admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is not set, it uses `GhostGate!2026` and prints a warning. Change it immediately.

### Create a license

1. Open the dashboard.
2. Click **New license**.
3. Set the customer, plan, devices, credits, max tokens per request, requests per minute, and expiry.
4. Click **Create license**.
5. Copy the full license key. It is shown **once**; the server stores only a hash.

### Activate a device

```bash
curl -X POST http://localhost:8080/v1/licenses/activate \
  -H "Content-Type: application/json" \
  -d '{
    "licenseKey": "GG-XXXX-XXXX-XXXX-XXXX",
    "hwid": "YOUR_DEVICE_ID",
    "deviceName": "My PC"
  }'
```

The response includes a `sessionToken`. Use it as a Bearer token for license and AI endpoints.

### Request an AI completion

```bash
curl -X POST http://localhost:8080/v1/ai/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -d '{
    "messages": [
      { "role": "user", "content": "Write a JavaScript function that reverses a string." }
    ],
    "maxTokens": 300
  }'
```

The server calls the configured AI provider, deducts credits based on token usage, and returns the content. The client never sees `AI_API_KEY`.

---

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env
docker compose up -d --build
```

Open **http://localhost:8080**.

The Docker image uses a named volume `ghostgate-data` for SQLite and the pepper file. Back up that volume.

---

## Admin dashboard

- **Overview** — active licenses, bound devices, credits remaining, 30-day AI requests, 14-day credit chart, recent activity, recent licenses.
- **Licenses** — search, filter by status, create, inspect, edit limits, add credits, suspend/revoke, unbind devices, export CSV.
- **Audit log** — every admin action and license event, with actor, entity, metadata, IP, and timestamp.
- **Settings** — admin password, server status, AI configuration, security model, and client integration snippet.

### License lifecycle

| Action | Effect |
| --- | --- |
| Create | Issues a key, sets credits, devices, token cap, rate limit, and expiry. |
| Activate | Binds a device and issues a short-lived session token. |
| Heartbeat | Validates the session and updates last-seen. |
| Add credits | Increases `credits_total`; usage is unchanged. |
| Suspend | Invalidates all active sessions immediately. |
| Reactivate | Sets status back to active; clients must activate again. |
| Revoke | Invalidates all active sessions and blocks new activations. |
| Unbind device | Revokes that device's sessions and frees a seat. |
| Expire | Blocks new activations and AI requests after `expires_at`. |

---

## Client integration

See **[`docs/CLIENT-INTEGRATION.md`](docs/CLIENT-INTEGRATION.md)** for Node.js, Rust, and Python examples.

The short version:

1. Compute a stable device ID (or use `node-machine-id` in the demo client).
2. POST to `/v1/licenses/activate`.
3. Store the returned session token securely.
4. Send `Authorization: Bearer <sessionToken>` on license and AI requests.
5. Handle `401` (re-activate), `402` (no credits), `403` (revoked/suspended/expired), `409` (device limit), and `429` (rate limit).

The demo client is included:

```bash
node scripts/demo-client.mjs --license "GG-XXXX-XXXX-XXXX-XXXX" --base http://localhost:8080
```

It activates the device, checks the heartbeat, and makes one AI request.

---

## API

Full reference: **[`docs/API.md`](docs/API.md)**.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Health and configuration status. |
| `POST` | `/v1/licenses/activate` | Activate a license on a device. |
| `GET` | `/v1/license` | Current license, device, session, and AI config. |
| `POST` | `/v1/license/heartbeat` | Validate the session and update last-seen. |
| `GET` | `/v1/license/usage` | Recent usage for the current license. |
| `POST` | `/v1/license/devices/release` | Release the current device. |
| `POST` | `/v1/usage` | Record client-reported usage and deduct credits. |
| `GET` | `/v1/ai/config` | Model and credit formula for the current license. |
| `POST` | `/v1/ai/completions` | Text-only AI proxy with credit deduction. |
| `POST` | `/v1/admin/login` | Admin sign-in. |
| `GET` | `/v1/admin/licenses` | List licenses. |
| `POST` | `/v1/admin/licenses` | Create a license. |
| `GET` | `/v1/admin/licenses/:id` | License detail with devices, usage, and audit. |
| `PATCH` | `/v1/admin/licenses/:id` | Update limits, status, expiry, notes. |
| `POST` | `/v1/admin/licenses/:id/credits` | Add credits. |
| `POST` | `/v1/admin/licenses/:id/status` | Suspend, activate, or revoke. |
| `DELETE` | `/v1/admin/licenses/:id/devices/:deviceId` | Unbind a device. |
| `GET` | `/v1/admin/audit-logs` | Audit trail. |
| `GET` | `/v1/admin/export` | CSV export. |
| `GET` | `/v1/admin/settings` | Server and AI configuration. |

---

## Security model

### Server-side enforcement

The server is the source of truth for:

- License validity and status.
- Device binding and device limits.
- Credit balance and token cost.
- Per-license rate limits.
- AI provider access.

A modified client cannot mint a license, increase credits, or use the AI key because it does not have the key and the server rejects requests without a valid session.

### Secrets and hashing

- License keys: 80-bit random, stored as SHA-256 hashes. The full key is shown once.
- Admin passwords: scrypt with a 16-byte random salt and 64-byte hash.
- Admin session tokens: 32 random bytes, stored as SHA-256 hashes, 12-hour default expiry.
- License session tokens: 32 random bytes, stored as SHA-256 hashes, 24-hour default expiry.
- Device IDs: HMAC-SHA256 with a server-side pepper. The raw device ID is not stored.
- AI provider key: environment variable on the server only.

### Transport and browser hardening

- Helmet CSP, HSTS, no-referrer, no-sniff, frame-ancestors `none`.
- CORS is disabled by default. Set `CORS_ORIGIN` to allow specific browser origins.
- Parameterized SQL throughout.
- Rate limits for activation, AI, and admin login.
- Audit logs for privileged actions.

### What it cannot guarantee

- A determined user can patch their local client. The server still enforces credits and device limits, but the client UI can be modified.
- A user can spoof a device ID. Use a stable OS-backed ID and monitor for suspicious activation patterns. For stronger binding, add TPM-backed attestation.
- SQLite is single-node. For high availability, move to PostgreSQL and run multiple server instances.
- This is not legal enforcement. Use your terms of service and applicable law for that.

Read **[`THREAT_MODEL.md`](THREAT_MODEL.md)** for the full threat model.

---

## Production checklist

- [ ] Set a long, random `HWID_PEPPER` (at least 32 characters).
- [ ] Set a strong `ADMIN_PASSWORD` and change it after first login.
- [ ] Set `AI_API_KEY` on the server only.
- [ ] Set `CORS_ORIGIN` to your client's exact origin, or leave empty for same-origin use.
- [ ] Serve behind HTTPS. Use Caddy, nginx, or a platform TLS terminator.
- [ ] Use a persistent volume for `DATA_DIR` and back it up.
- [ ] Run with `NODE_ENV=production`.
- [ ] Use `npm ci --omit=dev` in production.
- [ ] Restrict inbound access to the server (firewall, private network, or reverse proxy).
- [ ] Monitor audit logs and rate-limit responses.
- [ ] Rotate `AI_API_KEY` and `HWID_PEPPER` according to your incident-response policy.
- [ ] Keep the server updated.

See **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** for Docker, Render, and reverse-proxy examples.

---

## Project structure

```
src/
  app.js                 Fastify app, security middleware, error handling
  server.js              Process entry point and graceful shutdown
  db.js                  SQLite schema and connection
  lib/
    auth.js              Admin accounts, sessions, password changes
    licenses.js          License lifecycle, devices, credits, stats
    ai.js                Server-side AI provider proxy
    credits.js           Token-to-credit cost calculation
    audit.js             Audit log
    middleware.js        Admin and license session guards
    rate-limit.js        In-memory fixed-window limiter
    validation.js        Zod schemas
    utils.js             Hashing, tokens, HWID, env helpers
  routes/
    admin.js             Admin API
    licenses.js          Client license API
    ai.js                AI proxy API
public/
  index.html             Admin dashboard shell
  styles.css             Dashboard styles
  app.js                 Dashboard logic
scripts/
  create-admin.mjs       Create an admin from the CLI
  seed-demo.mjs          Create a demo license
  demo-client.mjs        End-to-end client demo
  build-release.sh       Build the release zip
test/
  server.test.js         End-to-end API tests
docs/
  API.md                 API reference
  CLIENT-INTEGRATION.md  Client integration guide
  DEPLOYMENT.md          Deployment guide
```

---

## Testing

```bash
npm test
```

The test suite starts a mock AI provider, creates a temporary SQLite database, and exercises:

- Admin login and authorization.
- License creation and key hashing.
- Device binding and device limits.
- Key normalization.
- Session heartbeat.
- AI completion and credit deduction.
- Client-reported usage.
- Credit top-ups and limit updates.
- Suspension, reactivation, and revocation.
- Device unbinding.
- Audit logs, stats, CSV export, and settings.
- Dashboard HTML delivery.
- Admin password change and session invalidation.
- Dashboard sign-in, overview rendering, and license creation through the UI (jsdom).

---

## Migrating from the old GhostAI code

The previous `src/main.rs`, `src/keyboard.rs`, `src/screen.rs`, `src/typer.rs`, `src/security.rs`, `src/ai.rs`, `src/scroller.rs`, `Cargo.toml`, and `Cargo.lock` were removed from this branch. They are still in Git history.

The old code contained exam-capture, stealth display affinity, global keyboard hook, and typing automation features. I did not enhance or port those features. If you need a legitimate AI coding assistant, build a client that calls GhostGate's text-only AI proxy and does not attempt to defeat monitoring.

---

## License

This project is provided under the terms in **[`LICENSE`](LICENSE)**. It is intended for the copyright holder's internal use and controlled distribution.

---

## Disclaimer

GhostGate is a licensing and usage-control tool. It does not provide legal, compliance, or exam-integrity advice. You are responsible for how you use it and for complying with the terms of the platforms and institutions you interact with.
