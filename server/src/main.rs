use anyhow::{Context, Result};
use ghost_control_server::{build_app, config::Config, db::{self, Db}, groq::GroqProvider, AppState};
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("server/.env");
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let config = Config::from_env()?;
    let db = Db::open(&config.db_path)?;
    let recovered = db::recover_interrupted_requests(&db)?;
    if recovered > 0 { tracing::warn!(count = recovered, "Interrupted AI requests are held for owner review"); }
    let provider_ready = !config.groq_api_key.is_empty();
    let provider = Arc::new(GroqProvider::new(config.clone())?);
    let address = format!("{}:{}", config.host, config.port);
    let state = Arc::new(AppState { config, db, provider, provider_ready });
    let app = build_app(state);
    let listener = TcpListener::bind(&address).await.with_context(|| format!("bind {address}"))?;
    tracing::info!(%address, "GhostAI control server listening");
    axum::serve(listener, app).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await?;
    Ok(())
}
