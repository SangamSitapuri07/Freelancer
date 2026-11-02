# Threat model

GhostGate is a self-hosted licensing and usage-control server. This document describes what it protects, what it does not, and how to deploy it responsibly.

## Assets

- **License keys** — bearer credentials for a customer's access.
- **Credit balance** — the customer's allowance of AI or client usage.
- **AI provider key** — the server-side credential used to call the AI provider.
- **Admin credentials** — the control-plane login.
- **Customer data** — names, emails, device identifiers, usage records.
- **Audit trail** — evidence of administrative and license events.

## Adversaries

1. **Casual user** — tries to use a license on more devices than allowed, or to keep using it after expiry.
2. **Determined reverse engineer** — patches the client, extracts embedded strings, or forges requests.
3. **Malicious customer** — tries to replay a session, reset credits, or use the AI key directly.
4. **Network attacker** — tries to intercept traffic or call the API from an unauthorized origin.
5. **Compromised server** — an attacker with filesystem or database access.

## Controls

### License and device binding

- License keys are 80-bit random and stored as SHA-256 hashes.
- Device IDs are normalized and stored as HMAC-SHA256 with a server-side pepper.
- Each license has a `max_devices` limit.
- Activation checks status, expiry, credits, and device count.
- Admin can unbind a device and revoke its sessions.
- A user can release their own device, freeing a seat.

### Session management

- License sessions are opaque 32-byte tokens.
- Only the SHA-256 hash is stored.
- Sessions expire after `SESSION_HOURS` (default 24).
- Suspension, revocation, device unbinding, and password changes revoke sessions.
- Admin sessions expire after `ADMIN_SESSION_HOURS` (default 12).
- Logout deletes the admin session row.

### Credit enforcement

- Credits are stored in a SQLite ledger.
- AI requests are serialized per license with an in-memory lock.
- The server checks the balance again inside the transaction before deducting.
- The AI provider is called only after the session and license checks pass.
- If the provider fails, no credits are deducted.
- If the balance is insufficient, the content is not returned.

### AI key protection

- `AI_API_KEY` is read from the server environment.
- The client calls `/v1/ai/completions`, not the AI provider directly.
- The server adds a system prompt and forwards only text messages.
- The API rejects image content. It is text-only by design.
- The settings endpoint reports whether AI is configured, but never returns the key.

### Admin protection

- Admin passwords use scrypt with a 16-byte salt and 64-byte hash.
- Admin sessions are opaque and hashed.
- Admin login is rate-limited per IP.
- Admin routes require a valid admin session.
- Privileged actions are written to the audit log.
- Password changes revoke all admin sessions.

### Browser and API hardening

- Helmet CSP, HSTS, no-referrer, no-sniff, frame-ancestors `none`.
- CORS is disabled by default.
- Parameterized SQL.
- Request body limit of 2 MiB.
- Global rate limit of 300 requests/minute.
- Activation rate limit of 20/minute/IP.
- AI rate limit per license (`rate_limit_per_minute`) and 60/minute/IP.
- Admin login rate limit of 10/minute/IP.

### Audit

- `LICENSE_CREATED`
- `LICENSE_UPDATED`
- `CREDITS_ADDED`
- `LICENSE_STATUS_CHANGED`
- `DEVICE_UNBOUND`
- `DEVICE_RELEASED`
- `LICENSE_ACTIVATED`

Each entry records actor type, actor ID, actor email, action, entity, metadata, IP, and timestamp.

## Limitations

### Client-side modification

A user with control of their machine can patch the client. They can change the UI, skip update checks, or attempt to call the API directly. They cannot:

- Mint a valid license key without the server's hash.
- Increase their credit balance without an admin session.
- Use the AI provider key, because it is not in the client.
- Bypass device limits, because the server counts devices.
- Bypass expiry or revocation, because the server checks them on every request.

Client-side obfuscation and anti-tampering can raise the cost of modification, but they are not a substitute for server-side enforcement. Do not promise users that a client is unbreakable.

### Device ID spoofing

A user can change the value they send as `hwid`. The server cannot prove that the value came from the real hardware without additional attestation. Mitigations:

- Use an OS-backed machine ID.
- Monitor for repeated activations from the same license across many device IDs.
- Set a low `max_devices` limit.
- Add TPM-backed attestation if your threat model requires it.
- Treat the device ID as a binding signal, not a hardware guarantee.

### Single-node SQLite

SQLite is excellent for a single-tenant control plane, but it is not a multi-node database. If you need high availability or horizontal scaling:

- Move to PostgreSQL.
- Run multiple stateless server instances.
- Use a shared database and a distributed rate limiter.
- Keep the audit log in the same database or ship it to a log service.

### No legal enforcement

Technical controls do not replace terms of service, contracts, or applicable law. If you need to enforce licensing legally, consult a lawyer.

### No DRM guarantee

GhostGate is not a DRM system. It does not encrypt the client binary, hide it from analysis, or prevent debugging. It is a server-side authorization and accounting system. That is the right architecture for a shareable client, but it is not a guarantee against reverse engineering.

## Recommendations

1. **Use HTTPS.** Serve GhostGate behind a TLS terminator. Do not expose plaintext HTTP.
2. **Set a long `HWID_PEPPER`.** At least 32 random characters. Store it outside the database.
3. **Set a strong admin password.** Change it after first login.
4. **Keep `AI_API_KEY` server-side.** Never put it in the client, the dashboard, or a public repository.
5. **Use a persistent volume.** Back up `DATA_DIR` regularly.
6. **Restrict CORS.** Set `CORS_ORIGIN` to the exact client origin.
7. **Monitor audit logs.** Look for repeated failed activations, device-limit errors, and revoked-license attempts.
8. **Rotate credentials.** Rotate `AI_API_KEY` and `HWID_PEPPER` according to your incident-response policy.
9. **Use a reverse proxy.** Caddy or nginx can handle TLS, compression, and access control.
10. **Keep the server updated.** Apply Node.js and dependency security updates.

## What I deliberately did not implement

- Screen capture or screenshot upload.
- `SetWindowDisplayAffinity` or any capture-exclusion stealth.
- Global low-level keyboard hooks.
- Keystroke interception or input blocking.
- Automated answer typing or humanized typing.
- Exam-specific prompts or question-solving features.
- Panic mode or anti-monitoring behavior.
- Client-side obfuscation or anti-debugging tricks.

These features are designed to defeat exam integrity and monitoring. They are outside the scope of this project.
