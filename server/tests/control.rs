use async_trait::async_trait;
use axum::{body::Body, http::{header, HeaderMap, Request, StatusCode}, Router};
use ghost_control_server::{build_app, config::Config, db::{self, Db}, error::ApiError, groq::{AiProvider, ProviderResult}, models::Usage, security, AppState};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};
use tower::ServiceExt;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
const DEVICE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Clone)]
enum Mode { Ok, Uncertain, Rejected }
struct MockProvider { mode: Mutex<Mode>, calls: AtomicUsize }
#[async_trait]
impl AiProvider for MockProvider {
    async fn complete(&self, _images: &[String], _language: &str) -> Result<ProviderResult, ApiError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.mode.lock().unwrap().clone() {
            Mode::Ok => Ok(ProviderResult { content: "int main(){}".into(), usage: Usage { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 }, provider_request_id: Some("test".into()) }),
            Mode::Uncertain => Err(ApiError::uncertain("provider timeout")),
            Mode::Rejected => Err(ApiError::new(StatusCode::BAD_GATEWAY, "provider_rejected", "rejected")),
        }
    }
}

struct TestApp { app: Router, state: Arc<AppState> }
fn test_app(mode: Mode) -> TestApp {
    let config = Config::for_test(":memory:".into());
    let db = Db::memory().unwrap();
    let provider = Arc::new(MockProvider { mode: Mutex::new(mode), calls: AtomicUsize::new(0) });
    let state = Arc::new(AppState { config, db, provider: provider.clone(), provider_ready: true });
    TestApp { app: build_app(state.clone()), state }
}

fn insert_license(state: &AppState, code: &str, token_limit: i64, request_limit: i64, expires: Option<String>) -> String {
    let conn = state.db.lock().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute("INSERT INTO licenses(id,label,code_hash,token_limit,request_limit,expires_at,created_at) VALUES(?1,'Test',?2,?3,?4,?5,?6)",
        params![id, security::code_hash(code, &state.config.pepper), token_limit, request_limit, expires, db::now()]).unwrap();
    id
}

struct Reply { status: StatusCode, headers: HeaderMap, text: String }
impl Reply { fn json(&self) -> Value { serde_json::from_str(&self.text).unwrap() } }
async fn send(app: &Router, method: &str, uri: &str, headers: Vec<(&str, String)>, body: Option<String>, content_type: &str) -> Reply {
    let mut builder = Request::builder().method(method).uri(uri);
    for (k, v) in headers { builder = builder.header(k, v); }
    let request = if let Some(body) = body { builder.header(header::CONTENT_TYPE, content_type).body(Body::from(body)).unwrap() } else { builder.body(Body::empty()).unwrap() };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply { status, headers, text: String::from_utf8(bytes.to_vec()).unwrap() }
}
async fn json_request(app: &Router, method: &str, uri: &str, token: Option<&str>, body: Value, idem: Option<&str>) -> Reply {
    let mut headers = vec![];
    if let Some(token) = token { headers.push(("authorization", format!("Bearer {token}"))); }
    if let Some(idem) = idem { headers.push(("idempotency-key", idem.to_string())); }
    send(app, method, uri, headers, Some(body.to_string()), "application/json").await
}
async fn activate(app: &Router, code: &str, device: &str) -> Reply {
    json_request(app, "POST", "/v1/activate", None, json!({"code": code, "device_id": device}), None).await
}
async fn assist(app: &Router, token: &str, idem: &str) -> Reply {
    json_request(app, "POST", "/v1/assist", Some(token), json!({"language": "C++", "images": [PNG]}), Some(idem)).await
}
fn cookie(reply: &Reply) -> String {
    reply.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string()
}
fn csrf(html: &str) -> String {
    let marker = "name=\"csrf_token\" value=\"";
    let start = html.find(marker).unwrap() + marker.len();
    html[start..].split('"').next().unwrap().to_string()
}
async fn admin_login(app: &Router) -> (String, String) {
    let reply = send(app, "POST", "/admin/login", vec![], Some("password=test-admin-password-123".into()), "application/x-www-form-urlencoded").await;
    assert_eq!(reply.status, StatusCode::SEE_OTHER);
    let cookie = cookie(&reply);
    let dashboard = send(app, "GET", "/admin", vec![("cookie", cookie.clone())], None, "").await;
    assert_eq!(dashboard.status, StatusCode::OK);
    (cookie, csrf(&dashboard.text))
}

#[tokio::test]
async fn activation_binds_device_and_revoke_blocks() {
    let t = test_app(Mode::Ok);
    insert_license(&t.state, "12345678", 10000, 10, None);
    assert_eq!(activate(&t.app, "12345678", "bad").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(activate(&t.app, "00000000", DEVICE).await.status, StatusCode::UNAUTHORIZED);
    let ok = activate(&t.app, "12345678", DEVICE).await;
    assert_eq!(ok.status, StatusCode::OK);
    let token = ok.json()["session_token"].as_str().unwrap().to_string();
    assert_eq!(activate(&t.app, "12345678", DEVICE2).await.status, StatusCode::FORBIDDEN);
    let session = json_request(&t.app, "GET", "/v1/session", Some(&token), json!({}), None).await;
    assert_eq!(session.status, StatusCode::OK);
    {
        let conn = t.state.db.lock().unwrap();
        conn.execute("UPDATE licenses SET revoked_at=?1", params![db::now()]).unwrap();
    }
    assert_eq!(json_request(&t.app, "GET", "/v1/session", Some(&token), json!({}), None).await.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn quotas_idempotency_and_provider_accounting() {
    let t = test_app(Mode::Ok);
    insert_license(&t.state, "11111111", 10000, 1, None);
    let token = activate(&t.app, "11111111", DEVICE).await.json()["session_token"].as_str().unwrap().to_string();
    let first = assist(&t.app, &token, "idem-111111111111").await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    assert_eq!(first.json()["usage"]["total_tokens"], 100);
    let replay = assist(&t.app, &token, "idem-111111111111").await;
    assert_eq!(replay.status, StatusCode::OK);
    assert_eq!(replay.json()["answer"], first.json()["answer"]);
    let second = assist(&t.app, &token, "idem-222222222222").await;
    assert_eq!(second.status, StatusCode::PAYMENT_REQUIRED);
    let conn = t.state.db.lock().unwrap();
    let (tokens, requests): (i64, i64) = conn.query_row("SELECT tokens_used,requests_used FROM licenses", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((tokens, requests), (100, 1));
}

#[tokio::test]
async fn token_reservation_blocks_before_provider_call() {
    let t = test_app(Mode::Ok);
    insert_license(&t.state, "22222222", 100, 10, None);
    let token = activate(&t.app, "22222222", DEVICE).await.json()["session_token"].as_str().unwrap().to_string();
    let reply = assist(&t.app, &token, "idem-333333333333").await;
    assert_eq!(reply.status, StatusCode::PAYMENT_REQUIRED);
    let provider = t.state.provider.clone();
    // The mock is behind Arc<dyn AiProvider>; verify via DB that no request was reserved.
    let conn = t.state.db.lock().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM ai_requests", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
    drop(provider);
}

#[tokio::test]
async fn uncertain_requests_hold_allowance_until_owner_releases() {
    let t = test_app(Mode::Uncertain);
    insert_license(&t.state, "33333333", 10000, 10, None);
    let token = activate(&t.app, "33333333", DEVICE).await.json()["session_token"].as_str().unwrap().to_string();
    let reply = assist(&t.app, &token, "idem-444444444444").await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    let request_id = {
        let conn = t.state.db.lock().unwrap();
        let (id, held): (String, i64) = conn.query_row("SELECT id,tokens_used FROM ai_requests JOIN licenses ON licenses.id=ai_requests.license_id", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert!(held > 0);
        id
    };
    let (cookie, csrf) = admin_login(&t.app).await;
    let body = format!("csrf_token={csrf}&action=release");
    let release = send(&t.app, "POST", &format!("/admin/requests/{request_id}/reconcile"), vec![("cookie", cookie)], Some(body), "application/x-www-form-urlencoded").await;
    assert_eq!(release.status, StatusCode::SEE_OTHER);
    let conn = t.state.db.lock().unwrap();
    let (tokens, requests): (i64, i64) = conn.query_row("SELECT tokens_used,requests_used FROM licenses", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((tokens, requests), (0, 0));
}

#[tokio::test]
async fn rejected_provider_releases_reservation() {
    let t = test_app(Mode::Rejected);
    insert_license(&t.state, "44444444", 10000, 10, None);
    let token = activate(&t.app, "44444444", DEVICE).await.json()["session_token"].as_str().unwrap().to_string();
    assert_eq!(assist(&t.app, &token, "idem-555555555555").await.status, StatusCode::BAD_GATEWAY);
    let conn = t.state.db.lock().unwrap();
    let (tokens, requests, reserved): (i64, i64, i64) = conn.query_row("SELECT tokens_used,requests_used,reserved_tokens FROM licenses", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((tokens, requests, reserved), (0, 0, 0));
}

#[tokio::test]
async fn admin_can_create_code_and_dashboard_requires_csrf() {
    let t = test_app(Mode::Ok);
    assert_eq!(send(&t.app, "GET", "/admin", vec![], None, "").await.status, StatusCode::OK);
    let (cookie, csrf) = admin_login(&t.app).await;
    let bad = send(&t.app, "POST", "/admin/licenses", vec![("cookie", cookie.clone())], Some("csrf_token=bad&label=Alice&token_limit=10000&request_limit=10&expires_at=".into()), "application/x-www-form-urlencoded").await;
    assert_eq!(bad.status, StatusCode::FORBIDDEN);
    let body = format!("csrf_token={csrf}&label=Alice&token_limit=10000&request_limit=10&expires_at=");
    let created = send(&t.app, "POST", "/admin/licenses", vec![("cookie", cookie)], Some(body), "application/x-www-form-urlencoded").await;
    assert_eq!(created.status, StatusCode::OK);
    let marker = "Registration code (shown once): ";
    let start = created.text.find(marker).unwrap() + marker.len();
    let code = &created.text[start..start + 8];
    assert!(security::is_code(code));
    assert_eq!(activate(&t.app, code, DEVICE).await.status, StatusCode::OK);
}

#[tokio::test]
async fn invalid_images_and_activation_rate_limit() {
    let t = test_app(Mode::Ok);
    insert_license(&t.state, "55555555", 10000, 10, None);
    let token = activate(&t.app, "55555555", DEVICE).await.json()["session_token"].as_str().unwrap().to_string();
    let bad = json_request(&t.app, "POST", "/v1/assist", Some(&token), json!({"language":"C++","images":["not-base64"]}), Some("idem-666666666666")).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    for _ in 0..5 { assert_eq!(activate(&t.app, "99999999", DEVICE).await.status, StatusCode::UNAUTHORIZED); }
    assert_eq!(activate(&t.app, "99999999", DEVICE).await.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn expired_license_cannot_activate() {
    let t = test_app(Mode::Ok);
    insert_license(&t.state, "66666666", 10000, 10, Some("2000-01-01T00:00:00+00:00".into()));
    assert_eq!(activate(&t.app, "66666666", DEVICE).await.status, StatusCode::FORBIDDEN);
}
