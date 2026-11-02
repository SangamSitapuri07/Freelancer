use crate::{db, error::{ensure, ApiError}, models::License, security, AppState};
use axum::{extract::{Path, State}, http::{header, HeaderMap, StatusCode}, response::{Html, IntoResponse, Redirect, Response}, Form};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use rusqlite::{params, TransactionBehavior};
use serde::Deserialize;
use serde_json::json;
use std::{fmt::Write as _, sync::Arc};
use uuid::Uuid;

const COOKIE: &str = "ghost_admin";
const ADMIN_HOURS: i64 = 8;

#[derive(Deserialize)]
pub struct LoginForm { pub password: String }
#[derive(Deserialize)]
pub struct CsrfForm { pub csrf_token: String }
#[derive(Deserialize)]
pub struct CreateLicenseForm { pub csrf_token: String, pub label: String, pub token_limit: String, pub request_limit: String, pub expires_at: String }
#[derive(Deserialize)]
pub struct LicenseActionForm { pub csrf_token: String, pub action: String, pub label: Option<String>, pub token_limit: Option<String>, pub request_limit: Option<String>, pub expires_at: Option<String> }
#[derive(Deserialize)]
pub struct ReconcileForm { pub csrf_token: String, pub action: String }

fn esc(value: &str) -> String { html_escape::encode_text(value).into_owned() }

fn admin_token(conn: &rusqlite::Connection, headers: &HeaderMap) -> Option<String> {
    let token = security::cookie_value(headers, COOKIE)?;
    let hash = security::sha256_hex(&token);
    let expires: String = conn.query_row("SELECT expires_at FROM admin_sessions WHERE token_hash=?1", params![hash], |r| r.get(0)).ok()?;
    if expires > db::now() { Some(token) } else { None }
}

fn require_admin(conn: &rusqlite::Connection, headers: &HeaderMap, csrf: &str, state: &AppState) -> Result<String, ApiError> {
    let token = admin_token(conn, headers).ok_or_else(|| ApiError::unauthorized("admin_login_required", "Sign in as the owner"))?;
    ensure(security::constant_eq(csrf, &security::csrf_token(&token, &state.config.pepper)), ApiError::forbidden("csrf_failed", "Refresh the dashboard and try again"))?;
    Ok(token)
}

fn cookie_header(token: &str, max_age: i64, state: &AppState) -> String {
    let secure = if state.config.production { "; Secure" } else { "" };
    format!("{COOKIE}={token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}")
}

fn layout(title: &str, body: &str) -> String {
    format!(r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{}</title><link rel="stylesheet" href="/admin/style.css"></head><body>{body}</body></html>"#, esc(title))
}

fn login_page(error: Option<&str>) -> String {
    let error = error.map(|e| format!(r#"<p class="error">{}</p>"#, esc(e))).unwrap_or_default();
    layout("GhostAI owner sign-in", &format!(r#"<main class="narrow"><h1>GhostAI control</h1><p>Owner access only.</p>{error}<form method="post" action="/admin/login"><label>Owner password<input type="password" name="password" required autocomplete="current-password"></label><button type="submit">Sign in</button></form></main>"#))
}

pub fn dashboard_html(state: &AppState, csrf: &str, flash: Option<&str>, error: Option<&str>) -> Result<String, ApiError> {
    let conn = state.db.lock()?;
    let licenses = {
        let mut stmt = conn.prepare("SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500")?;
        let rows = stmt.query_map([], License::from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let requests = {
        let mut stmt = conn.prepare("SELECT r.id,r.license_id,l.label,r.status,r.actual_tokens,r.reserved_tokens,r.error_code,r.created_at FROM ai_requests r JOIN licenses l ON l.id=r.license_id ORDER BY r.created_at DESC LIMIT 100")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?, r.get::<_,Option<i64>>(4)?, r.get::<_,i64>(5)?, r.get::<_,Option<String>>(6)?, r.get::<_,String>(7)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let audits = {
        let mut stmt = conn.prepare("SELECT action,license_id,details,created_at FROM audit_events ORDER BY id DESC LIMIT 50")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,Option<String>>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut html = String::from(r#"<header><h1>GhostAI control</h1><form method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="{csrf}"><button class="secondary" type="submit">Sign out</button></form></header><main>"#);
    if let Some(message) = flash { let _ = write!(html, r#"<p class="notice">{}</p>"#, esc(message)); }
    if let Some(message) = error { let _ = write!(html, r#"<p class="error">{}</p>"#, esc(message)); }
    let _ = write!(html, r#"<section><h2>Create registration</h2><form method="post" action="/admin/licenses" class="grid"><input type="hidden" name="csrf_token" value="{csrf}"><label>User / label<input name="label" required maxlength="80"></label><label>Token limit<input name="token_limit" type="number" min="1" max="1000000000" value="100000" required></label><label>Request limit<input name="request_limit" type="number" min="1" max="1000000000" value="100" required></label><label>Expiry (UTC, optional)<input name="expires_at" type="datetime-local"></label><button type="submit">Create code</button></form></section>"#);
    html.push_str(r#"<section><h2>Licenses</h2><div class="table-wrap"><table><thead><tr><th>User</th><th>Tokens</th><th>Requests</th><th>Status</th><th>Device</th><th>Expiry</th><th>Manage</th></tr></thead><tbody>"#);
    for license in &licenses {
        let quota = license.quota();
        let status = if quota.revoked { "revoked" } else if !license.active() { "expired" } else { "active" };
        let expiry = license.expires_at.as_deref().unwrap_or("never");
        let device = if license.device_id.is_some() { "bound" } else { "unbound" };
        let _ = write!(html, r#"<tr><td>{}</td><td>{} / {}<br><small>{} remaining, {} held</small></td><td>{} / {}<br><small>{} remaining</small></td><td>{status}</td><td>{device}</td><td>{}</td><td><details><summary>Manage</summary><form method="post" action="/admin/licenses/{}"><input type="hidden" name="csrf_token" value="{csrf}"><label>Label<input name="label" value="{}" maxlength="80"></label><label>Token limit<input name="token_limit" type="number" min="1" value="{}"></label><label>Request limit<input name="request_limit" type="number" min="1" value="{}"></label><label>Expiry UTC<input name="expires_at" type="datetime-local" value="{}"></label><div class="actions"><button name="action" value="update">Save</button><button name="action" value="revoke" class="danger">Revoke</button><button name="action" value="enable" class="secondary">Enable</button><button name="action" value="reset_device" class="secondary">Reset device</button></div></form></details></td></tr>"#,
            esc(&license.label), quota.tokens_used, quota.token_limit, quota.tokens_remaining, quota.reserved_tokens,
            quota.requests_used, quota.request_limit, quota.requests_remaining, esc(expiry), esc(&license.id), esc(&license.label), license.token_limit, license.request_limit, esc(expiry.trim_end_matches("+00:00")));
    }
    html.push_str(r#"</tbody></table></div></section><section><h2>Recent AI requests</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Status</th><th>Tokens</th><th>Review</th></tr></thead><tbody>"#);
    for (id, _license_id, label, status, actual, reserved, error_code, created) in &requests {
        let review = if status == "uncertain" {
            format!(r#"<form method="post" action="/admin/requests/{}/reconcile"><input type="hidden" name="csrf_token" value="{csrf}"><button name="action" value="release" class="secondary">Release hold</button><button name="action" value="settle">Keep charge</button></form>"#, esc(id))
        } else { String::new() };
        let _ = write!(html, r#"<tr><td>{}</td><td>{}</td><td>{}<br><small>{}</small></td><td>{} actual / {} held</td><td>{review}</td></tr>"#, esc(created), esc(label), esc(status), esc(error_code.as_deref().unwrap_or("")), actual.unwrap_or(0), reserved);
    }
    html.push_str(r#"</tbody></table></div></section><section><h2>Audit log</h2><ul class="audit">"#);
    for (action, license_id, details, created) in &audits {
        let _ = write!(html, r#"<li><time>{}</time> <strong>{}</strong> {} <code>{}</code></li>"#, esc(created), esc(action), esc(license_id.as_deref().unwrap_or("")), esc(details));
    }
    html.push_str("</ul></section></main>");
    Ok(layout("GhostAI owner dashboard", &html))
}

pub async fn style() -> Response {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], include_str!("../static/style.css")).into_response()
}

pub async fn dashboard(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Response, ApiError> {
    let conn = state.db.lock()?;
    if admin_token(&conn, &headers).is_none() { return Ok(Html(login_page(None)).into_response()); }
    drop(conn);
    Ok(Html(dashboard_html_with_headers(&state, &headers, None, None)?).into_response())
}

pub fn dashboard_html_with_headers(state: &AppState, headers: &HeaderMap, flash: Option<&str>, error: Option<&str>) -> Result<String, ApiError> {
    let conn = state.db.lock()?;
    let token = admin_token(&conn, headers).ok_or_else(|| ApiError::unauthorized("admin_login_required", "Sign in as the owner"))?;
    drop(conn);
    let csrf = security::csrf_token(&token, &state.config.pepper);
    dashboard_html(state, &csrf, flash, error)
}

pub async fn login(State(state): State<Arc<AppState>>, headers: HeaderMap, Form(form): Form<LoginForm>) -> Result<Response, ApiError> {
    let mut conn = state.db.lock()?;
    let global = security::privacy_key("admin-login-global", &state.config.pepper);
    ensure(db::hit_limit(&mut conn, &global, 20, 15 * 60 * 1000)?, ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many sign-in attempts; try later"))?;
    if !security::constant_eq(&form.password, &state.config.admin_password) {
        db::audit(&conn, "admin_login_failed", None, json!({}))?;
        return Ok((StatusCode::UNAUTHORIZED, Html(login_page(Some("Invalid owner password")))).into_response());
    }
    let token = security::random_token("admin_");
    conn.execute("INSERT INTO admin_sessions(token_hash,created_at,expires_at) VALUES(?1,?2,?3)", params![security::sha256_hex(&token), db::now(), db::future_ms(ADMIN_HOURS * 3_600_000)])?;
    db::audit(&conn, "admin_login", None, json!({}))?;
    Ok(([(header::SET_COOKIE, cookie_header(&token, ADMIN_HOURS * 3600, &state))], Redirect::to("/admin")).into_response())
}

pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap, Form(form): Form<CsrfForm>) -> Result<Response, ApiError> {
    let conn = state.db.lock()?;
    let token = require_admin(&conn, &headers, &form.csrf_token, &state)?;
    conn.execute("DELETE FROM admin_sessions WHERE token_hash=?1", params![security::sha256_hex(&token)])?;
    Ok(([(header::SET_COOKIE, cookie_header("", 0, &state))], Redirect::to("/admin")).into_response())
}

fn parse_limit(raw: &str) -> Result<i64, ApiError> {
    let value = raw.trim().parse::<i64>().map_err(|_| ApiError::bad_request("Limits must be positive integers"))?;
    ensure((1..=1_000_000_000).contains(&value), ApiError::bad_request("Limits must be between 1 and 1,000,000,000"))?;
    Ok(value)
}

fn parse_expiry(raw: &str) -> Result<Option<String>, ApiError> {
    let raw = raw.trim();
    if raw.is_empty() { return Ok(None); }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) { return Ok(Some(dt.with_timezone(&Utc).to_rfc3339())); }
    if let Ok(naive) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M") {
        return Ok(Some(Utc.from_utc_datetime(&naive).to_rfc3339()));
    }
    Err(ApiError::bad_request("Expiry must be a valid UTC date/time"))
}

pub async fn create_license(State(state): State<Arc<AppState>>, headers: HeaderMap, Form(form): Form<CreateLicenseForm>) -> Result<Response, ApiError> {
    let mut conn = state.db.lock()?;
    require_admin(&conn, &headers, &form.csrf_token, &state)?;
    let label = form.label.trim();
    let result = (|| -> Result<String, ApiError> {
        ensure(!label.is_empty() && label.len() <= 80, ApiError::bad_request("Label must be 1–80 characters"))?;
        let token_limit = parse_limit(&form.token_limit)?;
        let request_limit = parse_limit(&form.request_limit)?;
        let expires_at = parse_expiry(&form.expires_at)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut code = String::new();
        let mut id = String::new();
        for _ in 0..20 {
            code = security::new_code();
            let hash = security::code_hash(&code, &state.config.pepper);
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM licenses WHERE code_hash=?1)", params![hash], |r| r.get(0))?;
            if !exists {
                id = Uuid::new_v4().to_string();
                tx.execute("INSERT INTO licenses(id,label,code_hash,token_limit,request_limit,expires_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id, label, hash, token_limit, request_limit, expires_at, db::now()])?;
                break;
            }
        }
        ensure(!id.is_empty(), ApiError::internal())?;
        db::audit(&tx, "license_created", Some(&id), json!({"token_limit": token_limit, "request_limit": request_limit}))?;
        tx.commit()?;
        Ok(code)
    })();
    drop(conn);
    match result {
        Ok(code) => Ok(Html(dashboard_html_with_headers(&state, &headers, Some(&format!("Registration code (shown once): {code}")), None)?).into_response()),
        Err(error) => Ok((error.status, Html(dashboard_html_with_headers(&state, &headers, None, Some(&error.message))?)).into_response()),
    }
}

pub async fn license_action(State(state): State<Arc<AppState>>, Path(id): Path<String>, headers: HeaderMap, Form(form): Form<LicenseActionForm>) -> Result<Response, ApiError> {
    let mut conn = state.db.lock()?;
    require_admin(&conn, &headers, &form.csrf_token, &state)?;
    let result = (|| -> Result<(), ApiError> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let license = tx.query_row("SELECT * FROM licenses WHERE id=?1", params![id], License::from_row).map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "not_found", "License not found"))?;
        match form.action.as_str() {
            "update" => {
                let label = form.label.as_deref().unwrap_or("").trim();
                ensure(!label.is_empty() && label.len() <= 80, ApiError::bad_request("Label must be 1–80 characters"))?;
                let token_limit = parse_limit(form.token_limit.as_deref().unwrap_or(""))?;
                let request_limit = parse_limit(form.request_limit.as_deref().unwrap_or(""))?;
                ensure(token_limit >= license.tokens_used + license.reserved_tokens, ApiError::bad_request("Token limit cannot be below already used/held tokens"))?;
                ensure(request_limit >= license.requests_used + license.reserved_requests, ApiError::bad_request("Request limit cannot be below already used/held requests"))?;
                let expires_at = parse_expiry(form.expires_at.as_deref().unwrap_or(""))?;
                tx.execute("UPDATE licenses SET label=?1,token_limit=?2,request_limit=?3,expires_at=?4 WHERE id=?5", params![label, token_limit, request_limit, expires_at, id])?;
                db::audit(&tx, "license_updated", Some(&id), json!({"token_limit": token_limit, "request_limit": request_limit}))?;
            }
            "revoke" => {
                tx.execute("UPDATE licenses SET revoked_at=?1 WHERE id=?2", params![db::now(), id])?;
                tx.execute("UPDATE sessions SET revoked_at=?1 WHERE license_id=?2 AND revoked_at IS NULL", params![db::now(), id])?;
                db::audit(&tx, "license_revoked", Some(&id), json!({}))?;
            }
            "enable" => {
                tx.execute("UPDATE licenses SET revoked_at=NULL WHERE id=?1", params![id])?;
                db::audit(&tx, "license_enabled", Some(&id), json!({}))?;
            }
            "reset_device" => {
                tx.execute("UPDATE licenses SET device_id=NULL,device_bound_at=NULL WHERE id=?1", params![id])?;
                tx.execute("UPDATE sessions SET revoked_at=?1 WHERE license_id=?2 AND revoked_at IS NULL", params![db::now(), id])?;
                db::audit(&tx, "device_reset", Some(&id), json!({}))?;
            }
            _ => return Err(ApiError::bad_request("Unknown action")),
        }
        tx.commit()?;
        Ok(())
    })();
    drop(conn);
    match result {
        Ok(()) => Ok(Redirect::to("/admin").into_response()),
        Err(error) => Ok((error.status, Html(dashboard_html_with_headers(&state, &headers, None, Some(&error.message))?)).into_response()),
    }
}

pub async fn reconcile(State(state): State<Arc<AppState>>, Path(id): Path<String>, headers: HeaderMap, Form(form): Form<ReconcileForm>) -> Result<Response, ApiError> {
    let mut conn = state.db.lock()?;
    require_admin(&conn, &headers, &form.csrf_token, &state)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let request = tx.query_row("SELECT * FROM ai_requests WHERE id=?1", params![id], crate::models::AiRequest::from_row).map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "not_found", "Request not found"))?;
    ensure(request.status == "uncertain", ApiError::conflict("not_uncertain", "Only uncertain requests can be reconciled"))?;
    match form.action.as_str() {
        "release" => {
            let actual = request.actual_tokens.unwrap_or(0);
            tx.execute("UPDATE licenses SET tokens_used=tokens_used-?1,requests_used=requests_used-1 WHERE id=?2", params![actual, request.license_id])?;
            tx.execute("UPDATE ai_requests SET status='failed',actual_tokens=0,error_code='owner_released',completed_at=?1 WHERE id=?2", params![db::now(), id])?;
            db::audit(&tx, "request_released", Some(&request.license_id), json!({"request_id": id, "released_tokens": actual}))?;
        }
        "settle" => {
            tx.execute("UPDATE ai_requests SET status='completed',error_code=NULL,completed_at=?1 WHERE id=?2", params![db::now(), id])?;
            db::audit(&tx, "request_settled", Some(&request.license_id), json!({"request_id": id}))?;
        }
        _ => return Err(ApiError::bad_request("Unknown reconciliation action")),
    }
    tx.commit()?;
    Ok(Redirect::to("/admin").into_response())
}
