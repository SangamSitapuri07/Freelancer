# Where and how to host GhostAI

## Recommended hosting

Use a small **Ubuntu 24.04 VPS** with a persistent disk:

- Hetzner Cloud, DigitalOcean Droplet, Vultr, Linode/Akamai, or AWS Lightsail.
- Minimum: 1 vCPU, 1 GB RAM, 20 GB disk. 2 GB RAM is more comfortable for Docker builds.
- Choose the region closest to your users.
- You need a domain or subdomain, for example `ghostai.example.com`.

Why a VPS: the server uses SQLite and must run as one instance with persistent storage. Generic serverless/free tiers with ephemeral disks are a bad fit unless you add an external database and persistent volume.

Managed alternative: Render / Fly.io / Railway can work only if you attach a persistent volume and run one instance. The steps below target a VPS with Docker Compose and Caddy.

## 0. Merge or choose the branch

Merge PR #2 into `ghost`, or deploy the session branch directly:

```bash
git clone https://github.com/SangamSitapuri07/Freelancer.git
cd Freelancer
# If PR #2 is merged:
git checkout ghost
# Otherwise:
# git fetch origin arena/ee6e7b7c-freelancer
# git checkout arena/ee6e7b7c-freelancer
```

## 1. Create the VPS and DNS

1. Create an Ubuntu 24.04 server with your SSH key.
2. Add a DNS `A` record: `ghostai.example.com -> YOUR_SERVER_IP`.
3. SSH in:

```bash
ssh root@YOUR_SERVER_IP
```

## 2. Install Docker and tools

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl git openssl ufw
curl -fsSL https://get.docker.com | sh
```

## 3. Configure firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

Do not expose port 8787 publicly. Caddy will proxy HTTPS to it locally.

## 4. Clone the repo on the server

```bash
mkdir -p /opt/ghostai
cd /opt/ghostai
git clone https://github.com/SangamSitapuri07/Freelancer.git .
git checkout ghost   # or the session branch if PR #2 is not merged
```

## 5. Create server secrets

```bash
openssl rand -base64 28   # ADMIN_PASSWORD
openssl rand -hex 32      # CODE_PEPPER
cp server/.env.example server/.env
nano server/.env
```

Set at least:

```env
GHOST_ENV=production
PUBLIC_ORIGIN=https://ghostai.example.com
TRUST_PROXY=true
ADMIN_PASSWORD=the-generated-password
CODE_PEPPER=the-generated-64-hex-characters
GROQ_API_KEY=your-server-only-groq-key
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
DB_PATH=/data/ghostai.sqlite
```

Keep `CODE_PEPPER` stable and backed up. Changing it invalidates existing registration codes. Never put `GROQ_API_KEY`, `ADMIN_PASSWORD`, or `CODE_PEPPER` in the client ZIP.

## 6. Start the Rust server

```bash
docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml logs -f
```

The app listens inside Docker on `0.0.0.0:8787`; Compose publishes it only to host loopback.

## 7. Add HTTPS with Caddy

Install Caddy from the official package repository:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Then create `/etc/caddy/Caddyfile`:

```caddyfile
ghostai.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

A starter file is also in `deploy/Caddyfile.example`.

```bash
systemctl reload caddy
curl https://ghostai.example.com/healthz
```

Expected:

```json
{"ok":true}
```

## 8. Create your first registration code

Open:

```text
https://ghostai.example.com/admin
```

Sign in with `ADMIN_PASSWORD`, create a license, set token/request limits and optional expiry, then copy the eight-digit code shown once.

## 9. Build the shareable Windows ZIP

Option A — GitHub Actions:

1. Open the repo → Actions → CI → Run workflow.
2. Enter `server_url = https://ghostai.example.com`.
3. Download the `GhostAI-windows-x64` artifact.

Option B — Windows machine with Rust:

```powershell
git clone https://github.com/SangamSitapuri07/Freelancer.git
cd Freelancer
git checkout ghost
./scripts/package-windows.ps1 -ServerUrl "https://ghostai.example.com"
```

Output:

```text
artifacts/GhostAI-windows-x64.zip
```

## 10. Distribute and manage

Send the ZIP and the eight-digit code to the user. The client activates against your server; the server enforces limits and revocation.

Owner tasks:

- Revoke: stops new authorized requests.
- Reset device: lets the same code activate on a new machine.
- Edit limits: increase/decrease future allowance.
- Review uncertain requests: release hold if Groq did not charge, keep charge if it did.

## Backups and updates

Back up the Docker volume `ghost-control-data` and `server/.env` (especially `CODE_PEPPER`).

Update:

```bash
cd /opt/ghostai
git pull
docker compose -f deploy/compose.yml up -d --build
```

## Process naming and persistence

Use your own product name, for example `GhostAI.exe`, and sign it with your Authenticode certificate. Do not rename it to `ctfmon.exe` or `svchost.exe`, kill Windows components, or install hidden persistence. If you want legitimate auto-start, add a visible, user-consented Startup entry under your own product name with a clear uninstall path.
