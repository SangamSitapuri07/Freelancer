# Client integration guide

GhostGate is designed for a shareable client that talks to your server. The client should be treated as untrusted: all license, device, credit, and rate-limit checks happen on the server.

## Integration flow

1. Compute a stable device ID.
2. Send the license key and device ID to `POST /v1/licenses/activate`.
3. Store the returned `sessionToken` securely.
4. Use the session token as a Bearer token for license and AI requests.
5. Handle errors and re-activate when the session expires.

```
Client                         GhostGate
  │                              │
  │  activate(licenseKey, hwid)  │
  │ ────────────────────────────▶│
  │                              │  check license, device, credits
  │  sessionToken                │
  │ ◀────────────────────────────│
  │                              │
  │  AI request(sessionToken)    │
  │ ────────────────────────────▶│
  │                              │  check credits, rate limit
  │                              │  call AI provider (server key)
  │  content + creditsRemaining  │
  │ ◀────────────────────────────│
```

## Device ID

Use a stable OS-backed identifier. On Windows, the Machine GUID is a common choice. On Linux, `/etc/machine-id`. On macOS, the IOPlatformUUID. Do not use a value that changes on every boot.

The server stores only an HMAC-SHA256 of the device ID with a server-side pepper. The raw device ID is never stored.

The demo client uses `node-machine-id` and falls back to a hash of hostname, platform, architecture, CPU model, and total memory.

## Node.js example

```js
const baseUrl = "http://localhost:8080";
const licenseKey = "GG-XXXX-XXXX-XXXX-XXXX";
const hwid = getStableDeviceId();

const activateResponse = await fetch(`${baseUrl}/v1/licenses/activate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ licenseKey, hwid, deviceName: "My PC" }),
});

if (!activateResponse.ok) {
  const error = await activateResponse.json();
  throw new Error(error.error.message);
}

const { sessionToken, license } = await activateResponse.json();
storeSecurely(sessionToken);

const aiResponse = await fetch(`${baseUrl}/v1/ai/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sessionToken}`,
  },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Write a JavaScript function that reverses a string." }],
    maxTokens: 300,
  }),
});

const ai = await aiResponse.json();
console.log(ai.content);
console.log(`Credits remaining: ${ai.creditsRemaining}`);
```

The full demo is in `scripts/demo-client.mjs`.

## Rust example

Use `reqwest` and `serde`. This is a generic client; it does not include any exam, capture, or input-automation features.

```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct ActivateRequest {
    license_key: String,
    hwid: String,
    device_name: String,
}

#[derive(Deserialize)]
struct ActivateResponse {
    session_token: String,
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct CompletionRequest {
    messages: Vec<Message>,
    max_tokens: u32,
}

#[derive(Deserialize)]
struct CompletionResponse {
    content: String,
    credits_remaining: i64,
}

pub struct GhostGate {
    base_url: String,
    license_key: String,
    hwid: String,
    session_token: Option<String>,
}

impl GhostGate {
    pub fn new(base_url: &str, license_key: &str, hwid: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            license_key: license_key.to_string(),
            hwid: hwid.to_string(),
            session_token: None,
        }
    }

    pub async fn activate(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let client = Client::new();
        let response = client
            .post(format!("{}/v1/licenses/activate", self.base_url))
            .json(&ActivateRequest {
                license_key: self.license_key.clone(),
                hwid: self.hwid.clone(),
                device_name: "My PC".to_string(),
            })
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(format!("Activation failed: {}", response.status()).into());
        }

        let data: ActivateResponse = response.json().await?;
        self.session_token = Some(data.session_token);
        Ok(())
    }

    pub async fn complete(&self, prompt: &str) -> Result<CompletionResponse, Box<dyn std::error::Error>> {
        let token = self
            .session_token
            .as_ref()
            .ok_or("No session token. Call activate() first.")?;

        let client = Client::new();
        let response = client
            .post(format!("{}/v1/ai/completions", self.base_url))
            .bearer_auth(token)
            .json(&CompletionRequest {
                messages: vec![Message {
                    role: "user".to_string(),
                    content: prompt.to_string(),
                }],
                max_tokens: 300,
            })
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(format!("AI request failed: {}", response.status()).into());
        }

        Ok(response.json().await?)
    }
}
```

## Python example

```python
import requests

BASE = "http://localhost:8080"
LICENSE_KEY = "GG-XXXX-XXXX-XXXX-XXXX"
HWID = get_stable_device_id()

response = requests.post(
    f"{BASE}/v1/licenses/activate",
    json={"licenseKey": LICENSE_KEY, "hwid": HWID, "deviceName": "My PC"},
    timeout=30,
)
response.raise_for_status()
session_token = response.json()["sessionToken"]

response = requests.post(
    f"{BASE}/v1/ai/completions",
    headers={"Authorization": f"Bearer {session_token}"},
    json={
        "messages": [
            {"role": "user", "content": "Write a JavaScript function that reverses a string."}
        ],
        "maxTokens": 300,
    },
    timeout=90,
)
response.raise_for_status()
data = response.json()
print(data["content"])
print(data["creditsRemaining"])
```

## Error handling

| Status | Code | What to do |
| --- | --- | --- |
| `401` | `LICENSE_SESSION_INVALID` | Re-activate with the license key and device ID. |
| `401` | `INVALID_LICENSE` | Ask the admin to check the key. |
| `402` | `NO_CREDITS` / `INSUFFICIENT_CREDITS` | Ask the admin for more credits. |
| `403` | `LICENSE_REVOKED` / `LICENSE_SUSPENDED` / `LICENSE_EXPIRED` | Stop using the client and contact the admin. |
| `409` | `DEVICE_LIMIT_REACHED` | Ask the admin to unbind a device. |
| `429` | `RATE_LIMITED` | Back off and retry after `Retry-After`. |
| `503` | `AI_NOT_CONFIGURED` | The server's `AI_API_KEY` is missing. Contact the admin. |

## Security notes for the client

- **Never embed `AI_API_KEY`.** The server uses it.
- **Use HTTPS.** Do not send license keys or session tokens over plaintext HTTP.
- **Store the session token securely.** Use the OS keychain or a protected credential store. Do not commit it to source control.
- **Treat the client as untrusted.** A user can patch the client. The server is the source of truth.
- **Do not implement stealth or anti-monitoring features.** They are outside the scope of this project and are designed to defeat exam integrity.
- **Do not send screenshots to the AI proxy.** The API is text-only by design.
- **Handle re-activation.** Sessions expire. The client should be able to re-activate with the license key and device ID.
- **Handle device limits.** If the user changes hardware, the old device may need to be unbound by the admin.
- **Log errors for support.** Include the license ID, device display ID, and error code, but never the session token or license key.

## Text-only AI proxy

The AI proxy accepts `user` and `assistant` text messages. It does not accept image content. This is intentional: it keeps the server's AI integration focused on text and avoids building a screenshot pipeline.

If you need a legitimate coding assistant, send the code or problem description as text. If you need to process an image, use a separate service that is not part of GhostGate.

## License key handling

- The full license key is shown once at creation.
- The server stores only a SHA-256 hash.
- The admin cannot retrieve the full key later.
- If a key is lost, revoke the license and issue a new one.
- Do not put license keys in URLs, logs, or screenshots.
