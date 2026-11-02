use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

static SESSION: RwLock<Option<String>> = RwLock::new(None);
static SERVER_URL: OnceLock<String> = OnceLock::new();

#[derive(Debug)]
pub struct ControlError { pub status: Option<u16>, pub message: String }
impl ControlError {
    fn new(message: impl Into<String>) -> Self { Self { status: None, message: message.into() } }
    pub fn is_auth(&self) -> bool { matches!(self.status, Some(401 | 403)) }
}
impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.message) }
}
impl std::error::Error for ControlError {}
impl From<reqwest::Error> for ControlError {
    fn from(value: reqwest::Error) -> Self { Self::new(format!("Control server connection failed: {value}")) }
}

fn file_config() -> Value {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() { paths.push(dir.join("ghostai.config.json")); }
    }
    paths.push(std::path::PathBuf::from("ghostai.config.json"));
    for path in paths {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) { return value; }
        }
    }
    Value::Null
}

pub fn preferred_language() -> String {
    std::env::var("GHOST_LANGUAGE").ok()
        .or_else(|| file_config()["language"].as_str().map(str::to_string))
        .unwrap_or_else(|| "C++".into())
}

pub fn server_url() -> Result<&'static str, ControlError> {
    if let Some(url) = SERVER_URL.get() { return Ok(url); }
    let raw = std::env::var("GHOST_SERVER_URL").ok()
        .or_else(|| option_env!("GHOST_SERVER_URL").map(str::to_string))
        .or_else(|| file_config()["server_url"].as_str().map(str::to_string))
        .unwrap_or_else(|| "http://127.0.0.1:8787".into());
    let url = reqwest::Url::parse(&raw).map_err(|_| ControlError::new("GHOST_SERVER_URL is invalid"))?;
    let host = url.host_str().unwrap_or("");
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(ControlError::new("GHOST_SERVER_URL must use HTTPS except on loopback"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ControlError::new("GHOST_SERVER_URL must not contain credentials"));
    }
    let origin = url.origin().ascii_serialization();
    let _ = SERVER_URL.set(origin);
    Ok(SERVER_URL.get().unwrap())
}

pub fn device_id() -> Result<String, ControlError> {
    let raw = machine_uid::get().map_err(|e| ControlError::new(format!("Could not read device identity: {e}")))?;
    Ok(hex::encode(Sha256::digest(format!("ghost-ai-device-v1:{raw}").as_bytes())))
}

pub fn session_token() -> Result<String, ControlError> {
    SESSION.read().unwrap().clone().ok_or_else(|| ControlError::new("GhostAI is not activated"))
}

fn client(timeout: Duration) -> Result<reqwest::Client, ControlError> {
    reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none()).build().map_err(ControlError::from)
}

async fn response_error(response: reqwest::Response) -> ControlError {
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text).ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("Control server returned HTTP {status}"));
    ControlError { status: Some(status), message }
}

#[derive(Deserialize)]
struct ActivateResponse { session_token: String, license: Value }
#[derive(Deserialize)]
struct AssistResponse { answer: String, license: Value, usage: Value }

trait SessionStore {
    fn load(&self) -> Result<Option<String>, ControlError>;
    fn save(&self, token: &str) -> Result<(), ControlError>;
    fn clear(&self) -> Result<(), ControlError>;
}

#[cfg(target_os = "windows")]
struct WindowsStore { service: String, user: String }
#[cfg(target_os = "windows")]
impl WindowsStore {
    fn new() -> Result<Self, ControlError> {
        let service = format!("GhostAI:{}", &hex::encode(Sha256::digest(server_url()?.as_bytes()))[..16]);
        Ok(Self { service, user: device_id()? })
    }
    fn entry(&self) -> Result<keyring::Entry, ControlError> {
        keyring::Entry::new(&self.service, &self.user).map_err(|e| ControlError::new(format!("Credential store error: {e}")))
    }
}
#[cfg(target_os = "windows")]
impl SessionStore for WindowsStore {
    fn load(&self) -> Result<Option<String>, ControlError> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(ControlError::new(format!("Credential store error: {e}"))),
        }
    }
    fn save(&self, token: &str) -> Result<(), ControlError> {
        self.entry()?.set_password(token).map_err(|e| ControlError::new(format!("Could not save activation: {e}")))
    }
    fn clear(&self) -> Result<(), ControlError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(ControlError::new(format!("Could not clear activation: {e}"))),
        }
    }
}

#[cfg(target_os = "windows")]
fn default_store() -> Result<Box<dyn SessionStore>, ControlError> { Ok(Box::new(WindowsStore::new()?)) }
#[cfg(not(target_os = "windows"))]
fn default_store() -> Result<Box<dyn SessionStore>, ControlError> { Err(ControlError::new("The GhostAI desktop client requires Windows")) }

#[cfg(target_os = "windows")]
fn prompt_code() -> Result<Option<String>, ControlError> {
    Ok(tinyfiledialogs::input_box("GhostAI activation", "Enter your 8-digit registration code:", ""))
}
#[cfg(target_os = "windows")]
fn show_error(message: &str) {
    tinyfiledialogs::message_box_ok("GhostAI", message, tinyfiledialogs::MessageBoxIcon::Error);
}

async fn activate(code: &str) -> Result<ActivateResponse, ControlError> {
    let response = client(Duration::from_secs(20))?.post(format!("{}/v1/activate", server_url()?))
        .json(&serde_json::json!({"code": code, "device_id": device_id()?})).send().await?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    Ok(response.json::<ActivateResponse>().await?)
}

async fn validate(token: &str) -> Result<Value, ControlError> {
    let response = client(Duration::from_secs(15))?.get(format!("{}/v1/session", server_url()?)).bearer_auth(token).send().await?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    let json: Value = response.json().await?;
    Ok(json["license"].clone())
}

#[cfg(target_os = "windows")]
pub async fn initialize() -> Result<(), ControlError> {
    let store = default_store()?;
    if let Some(token) = store.load()? {
        match validate(&token).await {
            Ok(quota) => {
                *SESSION.write().unwrap() = Some(token);
                tracing::info!(?quota, "Activation restored");
                return Ok(());
            }
            Err(error) if error.is_auth() => { store.clear()?; }
            Err(error) => return Err(error),
        }
    }
    for _ in 0..3 {
        let Some(code) = prompt_code()? else { return Err(ControlError::new("Activation cancelled")); };
        let code = code.trim().to_string();
        if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
            show_error("The registration code must contain exactly 8 digits.");
            continue;
        }
        match activate(&code).await {
            Ok(response) => {
                store.save(&response.session_token)?;
                *SESSION.write().unwrap() = Some(response.session_token);
                tracing::info!(quota=?response.license, "Activation successful");
                return Ok(());
            }
            Err(error) if error.is_auth() => show_error(&error.message),
            Err(error) => return Err(error),
        }
    }
    Err(ControlError::new("Activation failed"))
}

#[cfg(not(target_os = "windows"))]
pub async fn initialize() -> Result<(), ControlError> { default_store()?; Ok(()) }

pub async fn assist(images: Vec<String>, language: &str) -> Result<String, ControlError> {
    let token = session_token()?;
    let response = client(Duration::from_secs(120))?.post(format!("{}/v1/assist", server_url()?))
        .bearer_auth(token)
        .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
        .json(&serde_json::json!({"language": language, "images": images})).send().await?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    let response: AssistResponse = response.json().await?;
    tracing::info!(usage=?response.usage, quota=?response.license, "AI request completed");
    Ok(response.answer)
}

pub fn spawn_watch() {
    tokio::spawn(async {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let Ok(token) = session_token() else { continue };
            match validate(&token).await {
                Ok(_) => {}
                Err(error) if error.is_auth() => {
                    tracing::warn!(%error, "Activation revoked or expired; stopping client");
                    crate::OVERRIDE_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
                    crate::SOLUTION_READY.store(false, std::sync::atomic::Ordering::SeqCst);
                    crate::AI_SOLUTION.lock().unwrap().clear();
                    crate::SCREENSHOTS.lock().unwrap().clear();
                    *SESSION.write().unwrap() = None;
                    std::process::exit(0);
                }
                Err(error) => tracing::warn!(%error, "License check failed; AI requests still require server authorization"),
            }
        }
    });
}
