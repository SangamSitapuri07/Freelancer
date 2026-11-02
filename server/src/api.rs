use crate::{db, error::{ensure, ApiError}, models::*, security, AppState};
use axum::{extract::State, http::{HeaderMap, StatusCode}, Json};
use base64::Engine;
use rusqlite::{params, TransactionBehavior};
use serde_json::json;
use std::{net::IpAddr, sync::Arc};
use uuid::Uuid;

const LANGUAGES: [&str; 4] = ["C++", "Java", "C", "Python"];

fn client_ip(headers: &HeaderMap, state: &AppState) -> String {
    if state.config.trust_proxy {
        if let Some(raw) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(last) = raw.split(',').next_back().map(str::trim) {
                if last.parse::<IpAddr>().is_ok() { return last.to_string(); }
            }
        }
    }
    "direct".into()
}

fn bearer(headers: &HeaderMap) -> Result<String, ApiError> {
    let raw = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    let token = raw.strip_prefix("Bearer ").unwrap_or("");
    ensure(security::is_session_token(token), ApiError::unauthorized("invalid_session", "A valid activation session is required"))?;
    Ok(token.to_string())
}

fn require_session(conn: &rusqlite::Connection, headers: &HeaderMap) -> Result<(License, String, String), ApiError> {
    let token = bearer(headers)?;
    let token_hash = security::sha256_hex(&token);
    let session: (String, String, String, Option<String>) = conn.query_row(
        "SELECT license_id,device_id,expires_at,revoked_at FROM sessions WHERE token_hash=?1", params![token_hash],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|_| ApiError::unauthorized("invalid_session", "A valid activation session is required"))?;
    ensure(session.3.is_none(), ApiError::unauthorized("session_revoked", "This session has been revoked"))?;
    ensure(session.2 > db::now(), ApiError::unauthorized("session_expired", "Activate again to continue"))?;
    let license = conn.query_row("SELECT * FROM licenses WHERE id=?1", params![session.0], License::from_row)
        .map_err(|_| ApiError::unauthorized("invalid_session", "A valid activation session is required"))?;
    ensure(license.revoked_at.is_none(), ApiError::forbidden("license_revoked", "This registration has been revoked"))?;
    ensure(license.expires_at.as_deref().map(|e| e > db::now().as_str()).unwrap_or(true), ApiError::forbidden("license_expired", "This registration has expired"))?;
    ensure(license.device_id.as_deref() == Some(session.1.as_str()), ApiError::forbidden("device_mismatch", "This registration is bound to another device"))?;
    Ok((license, token_hash, token))
}

pub async fn activate(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<ActivateRequest>) -> Result<Json<ActivateResponse>, ApiError> {
    ensure(security::is_code(&body.code) && security::is_device_id(&body.device_id), ApiError::bad_request("Provide an eight-digit code and a 64-character lowercase hexadecimal device ID"))?;
    let ip_key = security::privacy_key(&format!("ip:{}", client_ip(&headers, &state)), &state.config.pepper);
    let code_key = security::privacy_key(&format!("code:{}", body.code), &state.config.pepper);
    let mut conn = state.db.lock()?;
    ensure(db::hit_limit(&mut conn, &ip_key, 20, 15 * 60 * 1000)?, ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many activation attempts; try later"))?;
    ensure(db::hit_limit(&mut conn, &code_key, 5, 15 * 60 * 1000)?, ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many attempts for this code; try later"))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let code_hash = security::code_hash(&body.code, &state.config.pepper);
    let mut license = tx.query_row("SELECT * FROM licenses WHERE code_hash=?1", params![code_hash], License::from_row)
        .map_err(|_| ApiError::unauthorized("invalid_code", "The registration code is not valid"))?;
    ensure(license.revoked_at.is_none(), ApiError::forbidden("license_revoked", "This registration has been revoked"))?;
    ensure(license.expires_at.as_deref().map(|e| e > db::now().as_str()).unwrap_or(true), ApiError::forbidden("license_expired", "This registration has expired"))?;
    match license.device_id.as_deref() {
        Some(device) => ensure(device == body.device_id, ApiError::forbidden("device_mismatch", "This registration is bound to another device"))?,
        None => {
            tx.execute("UPDATE licenses SET device_id=?1,device_bound_at=?2 WHERE id=?3", params![body.device_id, db::now(), license.id])?;
            license.device_id = Some(body.device_id.clone());
        }
    }
    tx.execute("UPDATE sessions SET revoked_at=?1 WHERE license_id=?2 AND revoked_at IS NULL", params![db::now(), license.id])?;
    let token = security::random_token("ghost_");
    let expires = db::future_days(state.config.session_days);
    tx.execute("INSERT INTO sessions(token_hash,license_id,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4,?5)",
        params![security::sha256_hex(&token), license.id, body.device_id, db::now(), expires])?;
    tx.execute("UPDATE licenses SET last_seen_at=?1 WHERE id=?2", params![db::now(), license.id])?;
    db::audit(&tx, "license_activated", Some(&license.id), json!({}))?;
    tx.commit()?;
    db::clear_limit(&conn, &code_key)?;
    Ok(Json(ActivateResponse { session_token: token, session_expires_at: expires, license: license.quota() }))
}

pub async fn session(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, ApiError> {
    let conn = state.db.lock()?;
    let (license, _, _) = require_session(&conn, &headers)?;
    conn.execute("UPDATE licenses SET last_seen_at=?1 WHERE id=?2", params![db::now(), license.id])?;
    Ok(Json(json!({"license": license.quota()})))
}

pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, ApiError> {
    let conn = state.db.lock()?;
    let (_, token_hash, _) = require_session(&conn, &headers)?;
    conn.execute("UPDATE sessions SET revoked_at=?1 WHERE token_hash=?2", params![db::now(), token_hash])?;
    Ok(Json(json!({"ok": true})))
}

fn validate_images(images: &[String], state: &AppState) -> Result<(), ApiError> {
    ensure(!images.is_empty() && images.len() <= state.config.max_images, ApiError::bad_request("Invalid screenshot count"))?;
    for image in images {
        ensure(image.len() <= 4 * state.config.max_image_bytes.div_ceil(3), ApiError::bad_request("Screenshot is too large"))?;
        let decoded = base64::engine::general_purpose::STANDARD.decode(image).map_err(|_| ApiError::bad_request("Screenshots must be canonical base64 PNG data"))?;
        ensure(base64::engine::general_purpose::STANDARD.encode(&decoded) == *image, ApiError::bad_request("Screenshots must be canonical base64 PNG data"))?;
        ensure(decoded.len() >= 33 && decoded.len() <= state.config.max_image_bytes, ApiError::bad_request("Screenshot is too large or invalid"))?;
        ensure(&decoded[..8] == b"\x89PNG\r\n\x1a\n" && &decoded[12..16] == b"IHDR", ApiError::bad_request("Only PNG screenshots are accepted"))?;
        let width = u32::from_be_bytes(decoded[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(decoded[20..24].try_into().unwrap());
        ensure((1..=8192).contains(&width) && (1..=8192).contains(&height), ApiError::bad_request("Screenshot dimensions are invalid"))?;
    }
    Ok(())
}

fn replay(request: &AiRequest, license: &License) -> Result<AssistResponse, ApiError> {
    match request.status.as_str() {
        "completed" => Ok(AssistResponse {
            answer: request.response.clone().unwrap_or_default(),
            usage: Usage { prompt_tokens: request.prompt_tokens.unwrap_or(0), completion_tokens: request.completion_tokens.unwrap_or(0), total_tokens: request.actual_tokens.unwrap_or(0) },
            request_id: request.id.clone(), license: license.quota(),
        }),
        "uncertain" => Err(ApiError::uncertain("This request is held against the allowance pending owner review")),
        "reserved" => Err(ApiError::conflict("request_in_progress", "This idempotency key is already processing")),
        _ => Err(ApiError::new(StatusCode::from_u16(request.http_status.unwrap_or(502) as u16).unwrap_or(StatusCode::BAD_GATEWAY), "previous_request_failed", "The earlier request with this idempotency key failed")),
    }
}

pub async fn assist(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<AssistRequest>) -> Result<Json<AssistResponse>, ApiError> {
    ensure(LANGUAGES.contains(&body.language.as_str()), ApiError::bad_request("Unsupported language"))?;
    validate_images(&body.images, &state)?;
    let idempotency = headers.get("idempotency-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    ensure((16..=128).contains(&idempotency.len()) && idempotency.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), ApiError::bad_request("A valid Idempotency-Key header is required"))?;
    ensure(state.provider_ready, ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "provider_not_configured", "The owner has not configured the AI provider"))?;
    let payload = json!({"language": body.language, "images": body.images});
    let payload_hash = security::sha256_hex(&serde_json::to_string(&payload)?);
    let estimate = i64::from(state.config.max_output_tokens) + i64::from(state.config.image_token_reserve) * body.images.len() as i64 + 512;
    let request_id = Uuid::new_v4().to_string();
    {
        let mut conn = state.db.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (license, _, _) = require_session(&tx, &headers)?;
        let existing = tx.query_row("SELECT * FROM ai_requests WHERE license_id=?1 AND idempotency_key=?2", params![license.id, idempotency], AiRequest::from_row).ok();
        if let Some(existing) = existing {
            ensure(existing.payload_hash == payload_hash, ApiError::conflict("idempotency_conflict", "This idempotency key was used with a different payload"))?;
            return Ok(Json(replay(&existing, &license)?));
        }
        ensure(license.active(), ApiError::forbidden("license_revoked", "This registration is not active"))?;
        ensure(license.reserved_requests < 1, ApiError::conflict("request_in_progress", "Wait for the current AI request to finish"))?;
        ensure(license.requests_used + license.reserved_requests < license.request_limit, ApiError::new(StatusCode::PAYMENT_REQUIRED, "request_limit_reached", "The request allowance has been exhausted"))?;
        ensure(license.tokens_used + license.reserved_tokens + estimate <= license.token_limit, ApiError::new(StatusCode::PAYMENT_REQUIRED, "token_limit_reached", "The token allowance is too low for this request"))?;
        tx.execute("INSERT INTO ai_requests(id,license_id,idempotency_key,payload_hash,status,reserved_tokens,created_at) VALUES(?1,?2,?3,?4,'reserved',?5,?6)",
            params![request_id, license.id, idempotency, payload_hash, estimate, db::now()])?;
        tx.execute("UPDATE licenses SET reserved_tokens=reserved_tokens+?1,reserved_requests=reserved_requests+1,last_seen_at=?2 WHERE id=?3", params![estimate, db::now(), license.id])?;
        tx.commit()?;
    }

    let result = state.provider.complete(&body.images, &body.language).await;
    let mut conn = state.db.lock()?;
    match result {
        Ok(result) => {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let request = tx.query_row("SELECT * FROM ai_requests WHERE id=?1", params![request_id], AiRequest::from_row)?;
            ensure(request.status == "reserved", ApiError::conflict("request_state_changed", "The request state changed unexpectedly"))?;
            tx.execute("UPDATE licenses SET tokens_used=tokens_used+?1,requests_used=requests_used+1,reserved_tokens=reserved_tokens-?2,reserved_requests=reserved_requests-1 WHERE id=?3",
                params![result.usage.total_tokens, request.reserved_tokens, request.license_id])?;
            tx.execute("UPDATE ai_requests SET status='completed',actual_tokens=?1,prompt_tokens=?2,completion_tokens=?3,response=?4,provider_request_id=?5,completed_at=?6 WHERE id=?7",
                params![result.usage.total_tokens, result.usage.prompt_tokens, result.usage.completion_tokens, result.content, result.provider_request_id, db::now(), request_id])?;
            let license = tx.query_row("SELECT * FROM licenses WHERE id=?1", params![request.license_id], License::from_row)?;
            tx.commit()?;
            Ok(Json(AssistResponse { answer: result.content, usage: result.usage, request_id, license: license.quota() }))
        }
        Err(error) => {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let request = tx.query_row("SELECT * FROM ai_requests WHERE id=?1", params![request_id], AiRequest::from_row)?;
            if request.status == "reserved" {
                if error.uncertain {
                    tx.execute("UPDATE licenses SET tokens_used=tokens_used+?1,requests_used=requests_used+1,reserved_tokens=reserved_tokens-?1,reserved_requests=reserved_requests-1 WHERE id=?2", params![request.reserved_tokens, request.license_id])?;
                    tx.execute("UPDATE ai_requests SET status='uncertain',actual_tokens=reserved_tokens,error_code=?1,http_status=?2,completed_at=?3 WHERE id=?4", params![error.code, error.status.as_u16() as i64, db::now(), request_id])?;
                } else {
                    tx.execute("UPDATE licenses SET reserved_tokens=reserved_tokens-?1,reserved_requests=reserved_requests-1 WHERE id=?2", params![request.reserved_tokens, request.license_id])?;
                    tx.execute("UPDATE ai_requests SET status='failed',error_code=?1,http_status=?2,completed_at=?3 WHERE id=?4", params![error.code, error.status.as_u16() as i64, db::now(), request_id])?;
                }
                db::audit(&tx, if error.uncertain { "request_uncertain" } else { "request_failed" }, Some(&request.license_id), json!({"request_id": request_id, "error": error.code}))?;
            }
            tx.commit()?;
            Err(error)
        }
    }
}
