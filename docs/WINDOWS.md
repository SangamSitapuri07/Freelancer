# Windows client build and ZIP packaging

## Build

On Windows with Rust stable:

```powershell
cargo build --release -p ghost_ai
```

Output: `target/release/ghost_ai.exe`.

## Package for distribution

```powershell
./scripts/package-windows.ps1 -ServerUrl "https://ghostai.example.com" -Language "C++"
```

Creates `artifacts/GhostAI-windows-x64.zip` containing:

- `ghost_ai.exe`
- `ghostai.config.json` (server URL and default language; no secrets)
- `Start-GhostAI.cmd`
- `README.txt`

The script prints the ZIP SHA-256 hash. Share the hash so recipients can verify the archive they received.

## Activation

On first run the client shows an eight-digit registration dialog. After activation it stores the session token in Windows Credential Manager under a GhostAI entry. On later runs it validates the stored session with the server. If the owner resets the device or revokes the license, the user must activate again or loses access.

## Configuration precedence

1. `GHOST_SERVER_URL` / `GHOST_LANGUAGE` environment variables
2. compile-time `GHOST_SERVER_URL`
3. `ghostai.config.json` beside the executable or in the working directory
4. loopback development default / C++

Non-loopback server URLs must use HTTPS.

## Code signing

For public distribution, sign `ghost_ai.exe` with your Authenticode certificate after building and before zipping. Signing helps recipients verify publisher identity and detect tampering; it does not make the client impossible to patch. The CI artifact is unsigned.

## CI artifact

GitHub Actions uploads `GhostAI-windows-x64`. The automatic CI package points to `http://127.0.0.1:8787` for development. Do not distribute that artifact to users; run the packaging script with your production URL.
