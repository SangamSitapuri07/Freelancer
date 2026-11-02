# GhostGate API reference

Base URL: `http://localhost:8080` in development. Use HTTPS in production.

All request and response bodies are JSON unless noted. All timestamps are ISO 8601 UTC.

## Authentication

### Admin

Send the admin session token as a Bearer token:

```http
Authorization: Bearer <adminSessionToken>
```

Get a token from `POST /v1/admin/login`. Admin tokens expire after `ADMIN_SESSION_HOURS` (default 12).

### License client

Send the license session token as a Bearer token:

```http
Authorization: Bearer <licenseSessionToken>
```

Get a token from `POST /v1/licenses/activate`. License tokens expire after `SESSION_HOURS` (default 24).

## Error format

```json
{
  "error": {
    "code": "DEVICE_LIMIT_REACHED",
    "message": "Device limit reached for this license. Ask the admin to unbind a device.",
    "details": {
      "activeDevices": 2,
      "maxDevices": 2
    }
  }
}
```

Common codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request body or query failed validation. |
| `INVALID_LICENSE_FORMAT` | 400 | License key is not in the expected format. |
| `INVALID_LICENSE` | 401 | License key hash is not found. |
| `LICENSE_SESSION_INVALID` | 401 | Session token is missing, expired, or revoked. |
| `ADMIN_UNAUTHORIZED` | 401 | Admin token is missing or invalid. |
| `INVALID_CREDENTIALS` | 401 | Admin email or password is wrong. |
| `NO_CREDITS` | 402 | License has no credits remaining. |
| `INSUFFICIENT_CREDITS` | 402 | Request costs more credits than remain. |
| `LICENSE_REVOKED` | 403 | License is revoked. |
| `LICENSE_SUSPENDED` | 403 | License is suspended. |
| `LICENSE_EXPIRED` | 403 | License expiry has passed. |
| `DEVICE_LIMIT_REACHED` | 409 | All device seats are in use. |
| `RATE_LIMITED` | 429 | Too many requests. Check `Retry-After`. |
| `AI_NOT_CONFIGURED` | 503 | `AI_API_KEY` is not set on the server. |
| `AI_PROVIDER_ERROR` | 502 | The AI provider returned an error. |
| `AI_TIMEOUT` | 504 | The AI provider timed out. |

---

## Health

### `GET /v1/health`

No authentication.

```json
{
  "status": "ok",
  "service": "ghostgate",
  "version": "1.0.0",
  "time": "2026-11-02T07:51:22.881Z",
  "database": "ok",
  "aiConfigured": true,
  "hwidPepperConfigured": true
}
```

---

## License client API

### `POST /v1/licenses/activate`

Activate a license on a device. If the device is already bound, its session is refreshed. If the device was unbound, it is re-bound and counts against the device limit.

```http
POST /v1/licenses/activate
Content-Type: application/json
```

```json
{
  "licenseKey": "GG-XXXX-XXXX-XXXX-XXXX",
  "hwid": "stable-device-id",
  "deviceName": "My PC"
}
```

Response `201`:

```json
{
  "sessionToken": "uVDGQZ0dHiDEUM6roNVwVVL6JYHzlP5-tD2VqkfAt9U",
  "expiresAt": "2026-11-03T07:51:22.843Z",
  "license": {
    "id": "lic_FkRWRrOcc5EbW-js",
    "keyMasked": "GG-••••-••••-••••-U8R4",
    "customerName": "Aarav Sharma",
    "customerEmail": "aarav@example.com",
    "product": "GhostGate Client",
    "plan": "pro",
    "status": "active",
    "maxDevices": 2,
    "maxTokensPerRequest": 4096,
    "rateLimitPerMinute": 20,
    "creditsTotal": 100,
    "creditsUsed": 0,
    "creditsRemaining": 100,
    "expiresAt": "2026-12-02T07:51:22.804Z",
    "devicesUsed": 1,
    "activeSessions": 1,
    "expired": false,
    "expiringSoon": false
  },
  "device": {
    "id": "dev_7Tea43TStLcdmN09",
    "deviceName": "My PC",
    "hwidDisplay": "0e91-6a1c-b9f3",
    "activatedAt": "2026-11-02T07:51:22.843Z",
    "lastSeenAt": "2026-11-02T07:51:22.843Z",
    "revokedAt": null
  }
}
```

Errors: `400`, `401`, `402`, `403`, `409`, `429`.

### `GET /v1/license`

Requires a license session token. Returns the current license, device, session, and AI configuration.

```http
GET /v1/license
Authorization: Bearer <licenseSessionToken>
```

Response `200`:

```json
{
  "license": { "...": "..." },
  "device": { "...": "..." },
  "session": {
    "id": "sess_To3I90h8jq5mq7XR",
    "expiresAt": "2026-11-03T07:51:22.843Z",
    "createdAt": "2026-11-02T07:51:22.843Z",
    "lastUsedAt": "2026-11-02T07:51:22.880Z",
    "revokedAt": null
  },
  "serverTime": "2026-11-02T07:51:22.881Z",
  "ai": {
    "configured": true,
    "model": "openai/gpt-oss-120b",
    "creditsPerRequest": 1,
    "tokensPerCredit": 1000
  }
}
```

### `POST /v1/license/heartbeat`

Requires a license session token. Same response as `GET /v1/license`. Use it to validate the session and update last-seen.

### `GET /v1/license/usage?limit=20`

Requires a license session token. Returns recent usage events for the current license.

### `POST /v1/license/devices/release`

Requires a license session token. Revokes the current device and its sessions.

```json
{
  "deviceId": "dev_7Tea43TStLcdmN09"
}
```

Response `200`:

```json
{ "ok": true }
```

### `POST /v1/usage`

Requires a license session token. Records client-reported usage and deducts credits. Use this only for non-AI usage; prefer `/v1/ai/completions` for AI requests so the server can measure token usage.

```json
{
  "kind": "client_usage",
  "credits": 1,
  "tokensIn": 0,
  "tokensOut": 0,
  "metadata": { "feature": "export" }
}
```

Response `200`:

```json
{
  "creditsUsed": 1,
  "creditsRemaining": 99,
  "usageId": "use_..."
}
```

### `GET /v1/ai/config`

Requires a license session token. Returns the model and credit formula for the current license.

```json
{
  "model": "openai/gpt-oss-120b",
  "creditsPerRequest": 1,
  "tokensPerCredit": 1000,
  "maxTokensPerRequest": 4096,
  "rateLimitPerMinute": 20
}
```

### `POST /v1/ai/completions`

Requires a license session token. Text-only. The server prepends a system prompt and calls the configured AI provider.

```json
{
  "messages": [
    { "role": "user", "content": "Write a JavaScript function that reverses a string." }
  ],
  "temperature": 0.2,
  "maxTokens": 300
```

Rules:

- `messages` must contain 1–20 items.
- Each item's role must be `user` or `assistant`.
- Each content string must be 1–20,000 characters.
- `maxTokens` is capped by the license's `maxTokensPerRequest`.
- The server does not accept image content.

Response `200`:

```json
{
  "content": "function reverse(s) { return [...s].reverse().join(\"\"); }",
  "model": "openai/gpt-oss-120b",
  "usage": {
    "promptTokens": 10,
    "completionTokens": 20,
    "totalTokens": 30
  },
  "maxTokens": 300,
  "creditsUsed": 2,
  "creditsRemaining": 98
}
```

Credit formula:

```
creditsUsed = AI_CREDITS_PER_REQUEST + ceil(totalTokens / AI_TOKENS_PER_CREDIT)
```

Defaults: `1 + ceil(totalTokens / 1000)`.

Errors: `400`, `401`, `402`, `429`, `502`, `503`, `504`.

---

## Admin API

### `POST /v1/admin/login`

```json
{
  "email": "admin@ghostgate.local",
  "password": "YourStrongPassword!2026"
}
```

Response `200`:

```json
{
  "token": "admin_session_token",
  "expiresAt": "2026-11-02T19:51:22.843Z",
  "admin": {
    "id": "adm_...",
    "email": "admin@ghostgate.local",
    "displayName": "Administrator"
  }
}
```

Errors: `400`, `401`, `429`.

### `GET /v1/admin/me`

Requires an admin token.

```json
{
  "admin": {
    "id": "adm_...",
    "email": "admin@ghostgate.local",
    "displayName": "Administrator",
    "expiresAt": "2026-11-02T19:51:22.843Z"
  },
  "serverTime": "2026-11-02T07:51:22.881Z"
}
```

### `POST /v1/admin/logout`

Requires an admin token. Deletes the current admin session.

### `POST /v1/admin/password`

Requires an admin token. Changes the admin password and revokes all admin sessions.

```json
{
  "currentPassword": "OldPassword!2026",
  "newPassword": "NewPassword!2026"
}
```

The new password must be at least 12 characters.

### `GET /v1/admin/stats`

Requires an admin token. Returns aggregate stats.

```json
{
  "totalLicenses": 12,
  "activeLicenses": 10,
  "suspendedLicenses": 1,
  "revokedLicenses": 1,
  "expiredLicenses": 0,
  "expiringSoonLicenses": 2,
  "totalDevices": 18,
  "activeSessions": 7,
  "creditsRemaining": 8400,
  "creditsUsed": 1600,
  "creditsTotal": 10000,
  "requests30d": 320,
  "creditsUsed30d": 1600,
  "tokens30d": 420000,
  "requestsToday": 12,
  "creditsToday": 60,
  "usageByDay": [
    { "date": "2026-10-20", "credits": 40, "requests": 8 }
  ],
  "topLicenses": [
    { "id": "lic_...", "customer_name": "Aarav", "product": "GhostGate Client", "plan": "pro", "credits": 500, "requests": 90 }
  ],
  "planMix": [
    { "plan": "standard", "count": 8 }
  ]
}
```

### `GET /v1/admin/licenses?search=&status=&page=1&pageSize=20`

Requires an admin token. `status` can be `all`, `active`, `suspended`, or `revoked`. `search` matches customer name, email, key last 4, or product.

Response `200`:

```json
{
  "total": 12,
  "page": 1,
  "pageSize": 20,
  "licenses": [
    {
      "id": "lic_...",
      "keyMasked": "GG-••••-••••-••••-U8R4",
      "keyLast4": "U8R4",
      "customerName": "Aarav Sharma",
      "customerEmail": "aarav@example.com",
      "product": "GhostGate Client",
      "plan": "pro",
      "status": "active",
      "maxDevices": 2,
      "maxTokensPerRequest": 4096,
      "rateLimitPerMinute": 20,
      "creditsTotal": 100,
      "creditsUsed": 2,
      "creditsRemaining": 98,
      "expiresAt": "2026-12-02T07:51:22.804Z",
      "devicesUsed": 1,
      "activeSessions": 1,
      "expired": false,
      "expiringSoon": false
    }
  ]
}
```

### `POST /v1/admin/licenses`

Requires an admin token. Creates a license and returns the full key once.

```json
{
  "customerName": "Aarav Sharma",
  "customerEmail": "aarav@example.com",
  "product": "GhostGate Client",
  "plan": "pro",
  "maxDevices": 2,
  "maxTokensPerRequest": 4096,
  "rateLimitPerMinute": 20,
  "credits": 100,
  "expiresInDays": 30,
  "notes": "Optional internal note"
}
```

Response `201`:

```json
{
  "license": { "...": "..." },
  "licenseKey": "GG-XXXX-XXXX-XXXX-XXXX"
}
```

The full key is not stored. Store it securely.

### `GET /v1/admin/licenses/:id`

Requires an admin token. Returns the license, devices, recent usage, and license audit log.

### `PATCH /v1/admin/licenses/:id`

Requires an admin token. Updates any of:

```json
{
  "customerName": "Aarav Sharma",
  "customerEmail": "aarav@example.com",
  "product": "GhostGate Client",
  "plan": "pro",
  "status": "active",
  "maxDevices": 2,
  "maxTokensPerRequest": 4096,
  "rateLimitPerMinute": 20,
  "creditsTotal": 150,
  "expiresAt": "2026-12-02T07:51:22.804Z",
  "notes": "Updated"
}
```

`creditsTotal` cannot be lower than `creditsUsed`. Setting `status` to `suspended` or `revoked` revokes active sessions.

### `POST /v1/admin/licenses/:id/credits`

Requires an admin token. Adds credits.

```json
{
  "amount": 50,
  "reason": "Top-up"
}
```

### `POST /v1/admin/licenses/:id/status`

Requires an admin token. Sets status to `active`, `suspended`, or `revoked`.

```json
{ "status": "suspended" }
```

Setting a status other than `active` revokes all active sessions.

### `DELETE /v1/admin/licenses/:id/devices/:deviceId`

Requires an admin token. Unbinds a device and revokes its sessions.

### `GET /v1/admin/licenses/:id/usage?limit=50`

Requires an admin token. Returns usage events for the license.

### `GET /v1/admin/licenses/:id/audit?limit=50`

Requires an admin token. Returns audit events for the license.

### `GET /v1/admin/audit-logs?limit=100&offset=0&search=`

Requires an admin token. Returns the global audit trail.

### `GET /v1/admin/export`

Requires an admin token. Returns a CSV file with license rows. License keys are masked.

### `GET /v1/admin/settings`

Requires an admin token. Returns server and AI configuration. It never returns `AI_API_KEY`.

```json
{
  "version": "1.0.0",
  "serverTime": "2026-11-02T07:51:22.881Z",
  "ai": {
    "configured": true,
    "model": "openai/gpt-oss-120b",
    "baseUrl": "https://api.groq.com/openai/v1",
    "creditsPerRequest": 1,
    "tokensPerCredit": 1000
  },
  "security": {
    "hwidPepperConfigured": true,
    "sessionHours": 24,
    "adminSessionHours": 12
  }
}
```

---

## Rate limits

| Scope | Limit |
| --- | --- |
| Global | 300 requests/minute |
| Activation | 20/minute/IP |
| Admin login | 10/minute/IP |
| AI per license | `rate_limit_per_minute` (default 20) |
| AI per IP | 60/minute |

When a limit is exceeded, the server returns `429` with a `Retry-After` header.

---

## Notes

- The AI proxy is text-only. It does not accept screenshots or images.
- The client must never embed `AI_API_KEY`.
- The client should store the session token securely and re-activate on `401`.
- The client should handle `402` by asking the admin for more credits.
- The client should handle `409` by asking the admin to unbind a device.
- The client should handle `429` by backing off and retrying.
