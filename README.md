# GhostAI — Rust client + owner-controlled server

This repository contains a Rust workspace:

- **`ghost_ai`** — Windows desktop client (`src/`).
- **`ghost-control-server`** — Rust/Axum control server (`server/`) with SQLite, an owner dashboard, eight-digit activation, device binding, token/request quotas, revocation, and a Groq proxy.

The desktop ZIP does **not** contain the Groq API key. The client activates against your server and sends AI requests through it. The server is the authority for access and spending.

> Security reality: a distributed executable cannot be made impossible to inspect or patch. Central control works because the provider key and quota ledger stay on the server. This project uses the normal `ghost_ai.exe` process name and does not impersonate Windows components or install hidden persistence.

## Important: rotate any previously committed Groq key

Earlier commits contained Groq-format credentials in `src/ai.rs` / `src/main.rs`. They have been removed from the working tree, but **Git history still contains them**. If any were real, revoke/rotate them in Groq. Removing a secret from the latest commit does not invalidate it.

## Architecture

```text
Windows client
  ├─ 8-digit code → POST /v1/activate → session token stored in Windows Credential Manager
  ├─ screenshots → POST /v1/assist → Rust server → Groq
  └─ periodic GET /v1/session → stop on revocation/expiry

Rust control server
  ├─ owner dashboard: /admin
  ├─ SQLite: licenses, sessions, reservations, usage, audit log
  ├─ atomic token + request reservation before provider call
  └─ provider-reported usage settled after completion
```

## Quick start: server

Requires Rust stable and a persistent disk. Node is not required.

```bash
cargo run -p ghost-control-server --bin gen-secrets
cp server/.env.example server/.env
# Edit server/.env: ADMIN_PASSWORD, CODE_PEPPER, GROQ_API_KEY
cargo run -p ghost-control-server
```

Open `http://127.0.0.1:8787/admin`, sign in with `ADMIN_PASSWORD`, create a registration, and copy the eight-digit code shown once.

For production, deploy behind HTTPS. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quick start: Windows client

```powershell
$env:GHOST_SERVER_URL = "https://your-server.example.com"
cargo build --release -p ghost_ai
./scripts/package-windows.ps1 -ServerUrl "https://your-server.example.com"
```

The ZIP is written to `artifacts/GhostAI-windows-x64.zip`. Extract it and run `Start-GhostAI.cmd` or `ghost_ai.exe`. The activation dialog accepts the owner-issued eight-digit code.

Client configuration can also live beside the executable in `ghostai.config.json`:

```json
{ "server_url": "https://your-server.example.com", "language": "C++" }
```

`GHOST_SERVER_URL` and `GHOST_LANGUAGE` override the file. HTTPS is required except for loopback development.

## Owner controls

The dashboard supports:

- create a registration with label, token limit, request limit, optional expiry;
- view used/remaining/held tokens and requests;
- edit limits and expiry;
- revoke / enable access;
- reset the bound device;
- review uncertain provider calls and release or keep the held charge;
- inspect an audit log.

Registration codes are random eight-digit values. The server stores only an HMAC of each code, not the code itself. Keep `CODE_PEPPER` stable and backed up; changing it invalidates existing codes.

## Quota semantics

Before a provider call, the server atomically reserves:

```text
max_output_tokens + image_token_reserve × image_count + 512
```

It also reserves one request and allows only one in-flight AI request per license. After a successful call, provider-reported `usage.total_tokens` replaces the reservation. If the provider outcome cannot be verified (timeout, interrupted response, missing usage, server crash), the reservation is held as an **uncertain** charge until the owner releases or settles it. This prevents silent free retries.

The final request can overshoot a token budget if the provider reports more usage than the conservative reservation. Increase `IMAGE_TOKEN_RESERVE` and set budgets with headroom. Provider usage is authoritative.

## Client hotkeys (existing runtime flow)

- `AAAA` — enter screenshot mode and clear the queue
- `SSSS` — capture a screenshot
- `DDDD` — send queued screenshots through the control server
- `FFFF` — start typing
- `GGGG` — stop typing
- `HHHH` — reset local state

Screenshots capture the primary display and may include private content. Close unrelated windows before capture.

## Tests and CI

```bash
cargo test -p ghost-control-server
cargo build --release -p ghost-control-server
cargo build --release -p ghost_ai   # Windows
```

GitHub Actions builds the server on Linux, builds/packages the Windows client, and uploads artifacts. The CI ZIP points at loopback for development; package your own ZIP with the production server URL.

## Documentation

- [Deployment](docs/DEPLOYMENT.md)
- [Security model and limits](docs/SECURITY.md)
- [Windows packaging](docs/WINDOWS.md)
