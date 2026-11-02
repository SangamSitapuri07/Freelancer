# Security model and limits

## What is protected

- The Groq API key exists only on the control server.
- Registration codes are stored as HMACs under `CODE_PEPPER`, not plaintext.
- Session tokens are random 256-bit values; the server stores SHA-256 hashes.
- Windows client session tokens are stored in Windows Credential Manager, not a plaintext config file.
- Activation is rate-limited per code and globally per deployment; admin login is rate-limited.
- Licenses can be revoked, expired, and bound to one device.
- Token and request reservations are atomic in SQLite. A license has at most one in-flight AI request.
- Admin forms use a per-session CSRF token, HttpOnly/SameSite cookies, and Secure cookies in production.
- The dashboard escapes user-controlled text and uses a restrictive CSP with no JavaScript.

## What is not protected

- A user who controls their computer can inspect, patch, or replace the client executable. No client-side encryption, stripping, or obfuscation makes it unmodifiable.
- Device binding uses a hashed OS machine identifier. It is a licensing convenience, not a hardware root of trust; a modified client can spoof it. Server-side limits still protect your provider budget.
- A modified client can point at another server, but it cannot use your Groq key or quota ledger without a valid session.
- Cached answers already received by a client cannot be remotely erased with certainty. Revocation stops new authorized server requests and the normal client exits on its next license check.
- Eight digits are only 100 million possibilities. They are acceptable as online activation codes **because** the server rate-limits and binds them; they are not suitable as offline encryption keys.

## Operational rules

- Rotate any Groq key previously committed to Git. History retains old blobs even after deletion.
- Keep `CODE_PEPPER` and `ADMIN_PASSWORD` out of Git and out of the client ZIP.
- Back up `CODE_PEPPER`; losing it invalidates issued codes.
- Use HTTPS for all non-loopback client/server traffic.
- Restrict access to `/admin` at the network/proxy layer when possible.
- Treat screenshots as sensitive: they capture the primary display and are sent to the server and Groq.
- Review uncertain charges rather than automatically refunding them.

## Out of scope

This repository does not add Windows-component impersonation, hidden persistence, proctoring evasion, or anti-analysis behavior. Centralized licensing and quota enforcement do not require those features.
