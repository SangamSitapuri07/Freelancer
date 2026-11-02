pub mod admin;
pub mod api;
pub mod config;
pub mod db;
pub mod error;
pub mod groq;
pub mod models;
pub mod security;

use axum::{body::Body, extract::{DefaultBodyLimit, Request}, http::{header, HeaderValue}, middleware::{self, Next}, response::{Redirect, Response}, routing::{get, post}, Json, Router};
use config::Config;
use db::Db;
use groq::AiProvider;
use std::sync::Arc;

pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub provider: Arc<dyn AiProvider>,
    pub provider_ready: bool,
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if path.starts_with("/admin") {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; style-src 'self'; script-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"));
    }
    response
}

pub fn build_app(state: Arc<AppState>) -> Router {
    let body_limit = state.config.request_body_bytes;
    Router::new()
        .route("/", get(|| async { Redirect::to("/admin") }))
        .route("/healthz", get(|| async { Json(serde_json::json!({"ok": true})) }))
        .route("/v1/activate", post(api::activate))
        .route("/v1/session", get(api::session))
        .route("/v1/logout", post(api::logout))
        .route("/v1/assist", post(api::assist))
        .route("/admin", get(admin::dashboard))
        .route("/admin/style.css", get(admin::style))
        .route("/admin/login", post(admin::login))
        .route("/admin/logout", post(admin::logout))
        .route("/admin/licenses", post(admin::create_license))
        .route("/admin/licenses/:id", post(admin::license_action))
        .route("/admin/requests/:id/reconcile", post(admin::reconcile))
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}
