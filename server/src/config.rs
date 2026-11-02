use anyhow::{bail, Context, Result};
use std::{env, path::PathBuf};
use url::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub production: bool,
    pub host: String,
    pub port: u16,
    pub db_path: PathBuf,
    pub admin_password: String,
    pub pepper: Vec<u8>,
    pub public_origin: Option<String>,
    pub trust_proxy: bool,
    pub groq_api_key: String,
    pub groq_model: String,
    pub max_output_tokens: u32,
    pub image_token_reserve: u32,
    pub max_images: usize,
    pub max_image_bytes: usize,
    pub request_body_bytes: usize,
    pub session_days: i64,
    pub provider_timeout_ms: u64,
}

fn parse_int<T: std::str::FromStr>(name: &str, fallback: T, min: T, max: T) -> Result<T>
where T: PartialOrd + Copy {
    match env::var(name) {
        Err(_) => Ok(fallback),
        Ok(raw) if raw.is_empty() => Ok(fallback),
        Ok(raw) => {
            let value = raw.parse::<T>().with_context(|| format!("{name} has an invalid integer value"))?;
            if value < min || value > max { bail!("{name} is outside its allowed range"); }
            Ok(value)
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let production = env::var("NODE_ENV").ok().as_deref() == Some("production")
            || env::var("GHOST_ENV").ok().as_deref() == Some("production");
        let admin_password = env::var("ADMIN_PASSWORD").unwrap_or_default();
        let lower = admin_password.to_ascii_lowercase();
        if admin_password.len() < 16 || ["change-me", "changeme", "password", "replace-me", "replace_me"].iter().any(|p| lower.starts_with(p)) {
            bail!("ADMIN_PASSWORD must be a non-placeholder value of at least 16 characters");
        }
        let pepper_hex = env::var("CODE_PEPPER").unwrap_or_default();
        let pepper = hex::decode(&pepper_hex).context("CODE_PEPPER must be 64 hexadecimal characters")?;
        if pepper.len() != 32 || pepper.iter().all(|b| *b == 0) {
            bail!("CODE_PEPPER must be 32 random bytes encoded as 64 hexadecimal characters");
        }
        let public_origin = match env::var("PUBLIC_ORIGIN") {
            Ok(raw) if !raw.is_empty() => {
                let url = Url::parse(&raw).context("PUBLIC_ORIGIN must be a valid origin")?;
                if url.path() != "/" || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
                    bail!("PUBLIC_ORIGIN must not contain a path, query, fragment, or credentials");
                }
                if production && url.scheme() != "https" { bail!("Production PUBLIC_ORIGIN must use HTTPS"); }
                Some(url.origin().ascii_serialization())
            }
            _ if production => bail!("PUBLIC_ORIGIN is required in production"),
            _ => None,
        };
        let groq_api_key = env::var("GROQ_API_KEY").unwrap_or_default().trim().to_string();
        if production && groq_api_key.is_empty() { bail!("GROQ_API_KEY is required in production"); }
        let max_image_bytes = parse_int("MAX_IMAGE_BYTES", 2 * 1024 * 1024usize, 1024, 4 * 1024 * 1024)?;
        let max_images = parse_int("MAX_IMAGES", 5usize, 1, 8)?;
        Ok(Self {
            production,
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            port: parse_int("PORT", 8787u16, 1, 65535)?,
            db_path: env::var("DB_PATH").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("data/ghostai.sqlite")),
            admin_password,
            pepper,
            public_origin,
            trust_proxy: matches!(env::var("TRUST_PROXY").as_deref(), Ok("1" | "true" | "yes")),
            groq_api_key,
            groq_model: env::var("GROQ_MODEL").unwrap_or_else(|_| "meta-llama/llama-4-scout-17b-16e-instruct".into()),
            max_output_tokens: parse_int("MAX_OUTPUT_TOKENS", 2048u32, 128, 8192)?,
            image_token_reserve: parse_int("IMAGE_TOKEN_RESERVE", 4096u32, 256, 32768)?,
            max_images,
            max_image_bytes,
            request_body_bytes: (max_image_bytes * max_images * 4) / 3 + 128 * 1024,
            session_days: parse_int("SESSION_DAYS", 30i64, 1, 90)?,
            provider_timeout_ms: parse_int("PROVIDER_TIMEOUT_MS", 90_000u64, 1000, 180_000)?,
        })
    }

    pub fn for_test(db_path: PathBuf) -> Self {
        Self {
            production: false,
            host: "127.0.0.1".into(), port: 0, db_path,
            admin_password: "test-admin-password-123".into(),
            pepper: vec![7u8; 32], public_origin: None, trust_proxy: false,
            groq_api_key: String::new(), groq_model: "test-model".into(),
            max_output_tokens: 128, image_token_reserve: 256,
            max_images: 2, max_image_bytes: 1024,
            request_body_bytes: 128 * 1024, session_days: 1, provider_timeout_ms: 1000,
        }
    }
}
