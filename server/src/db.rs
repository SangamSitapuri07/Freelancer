use crate::{error::ApiError, models::AiRequest};
use anyhow::{Context, Result};
use chrono::{Duration, Utc};
use rusqlite::{params, Connection, TransactionBehavior};
use std::{path::Path, sync::{Mutex, MutexGuard}};

pub struct Db { conn: Mutex<Connection> }

pub fn now() -> String { Utc::now().to_rfc3339() }
pub fn future_days(days: i64) -> String { (Utc::now() + Duration::days(days)).to_rfc3339() }
pub fn future_ms(ms: i64) -> String { (Utc::now() + Duration::milliseconds(ms)).to_rfc3339() }

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).context("create database directory")?; }
        let conn = Connection::open(path).context("open SQLite database")?;
        let db = Self { conn: Mutex::new(conn) };
        db.init()?;
        Ok(db)
    }
    pub fn memory() -> Result<Self> {
        let db = Self { conn: Mutex::new(Connection::open_in_memory()?) };
        db.init()?;
        Ok(db)
    }
    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>, ApiError> {
        self.conn.lock().map_err(|_| ApiError::internal())
    }
    fn init(&self) -> Result<()> {
        let conn = self.lock().map_err(|_| anyhow::anyhow!("database lock poisoned"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(r#"
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS licenses (
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              code_hash TEXT NOT NULL UNIQUE,
              token_limit INTEGER NOT NULL CHECK(token_limit > 0),
              request_limit INTEGER NOT NULL CHECK(request_limit > 0),
              tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
              requests_used INTEGER NOT NULL DEFAULT 0 CHECK(requests_used >= 0),
              reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
              reserved_requests INTEGER NOT NULL DEFAULT 0 CHECK(reserved_requests >= 0),
              device_id TEXT,
              device_bound_at TEXT,
              expires_at TEXT,
              revoked_at TEXT,
              created_at TEXT NOT NULL,
              last_seen_at TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              license_id TEXT NOT NULL REFERENCES licenses(id),
              device_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS sessions_license ON sessions(license_id);
            CREATE TABLE IF NOT EXISTS admin_sessions (
              token_hash TEXT PRIMARY KEY,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ai_requests (
              id TEXT PRIMARY KEY,
              license_id TEXT NOT NULL REFERENCES licenses(id),
              idempotency_key TEXT NOT NULL,
              payload_hash TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed','uncertain')),
              reserved_tokens INTEGER NOT NULL,
              actual_tokens INTEGER,
              prompt_tokens INTEGER,
              completion_tokens INTEGER,
              response TEXT,
              error_code TEXT,
              http_status INTEGER,
              provider_request_id TEXT,
              created_at TEXT NOT NULL,
              completed_at TEXT,
              UNIQUE(license_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS ai_requests_recent ON ai_requests(created_at DESC);
            CREATE TABLE IF NOT EXISTS rate_buckets (
              key TEXT PRIMARY KEY,
              window_start INTEGER NOT NULL,
              count INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              action TEXT NOT NULL,
              license_id TEXT,
              details TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
        "#)?;
        Ok(())
    }
}

pub fn audit(conn: &Connection, action: &str, license_id: Option<&str>, details: serde_json::Value) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO audit_events(action,license_id,details,created_at) VALUES(?1,?2,?3,?4)",
        params![action, license_id, details.to_string(), now()])?;
    Ok(())
}

pub fn hit_limit(conn: &mut Connection, key: &str, limit: i64, window_ms: i64) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let timestamp = Utc::now().timestamp_millis();
    let existing: Option<(i64, i64)> = tx.query_row("SELECT window_start,count FROM rate_buckets WHERE key=?1", params![key], |r| Ok((r.get(0)?, r.get(1)?))).ok();
    let allowed = match existing {
        Some((start, _)) if timestamp - start < window_ms => {
            let count: i64 = tx.query_row("SELECT count FROM rate_buckets WHERE key=?1", params![key], |r| r.get(0))?;
            if count >= limit { false } else {
                tx.execute("UPDATE rate_buckets SET count=count+1 WHERE key=?1", params![key])?;
                true
            }
        }
        _ => {
            tx.execute("INSERT INTO rate_buckets(key,window_start,count) VALUES(?1,?2,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=1", params![key, timestamp])?;
            true
        }
    };
    tx.commit()?;
    Ok(allowed)
}

pub fn clear_limit(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM rate_buckets WHERE key=?1", params![key])?;
    Ok(())
}

pub fn recover_interrupted_requests(db: &Db) -> Result<usize> {
    let mut conn = db.lock().map_err(|_| anyhow::anyhow!("database lock poisoned"))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let rows = {
        let mut stmt = tx.prepare("SELECT id,license_id,reserved_tokens FROM ai_requests WHERE status='reserved'")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (id, license_id, reserved) in &rows {
        tx.execute("UPDATE licenses SET tokens_used=tokens_used+?1,requests_used=requests_used+1,reserved_tokens=reserved_tokens-?1,reserved_requests=reserved_requests-1 WHERE id=?2", params![reserved, license_id])?;
        tx.execute("UPDATE ai_requests SET status='uncertain',actual_tokens=reserved_tokens,error_code='interrupted',completed_at=?1 WHERE id=?2", params![now(), id])?;
        audit(&tx, "request_interrupted", Some(license_id), serde_json::json!({"request_id": id, "held_tokens": reserved}))?;
    }
    tx.commit()?;
    Ok(rows.len())
}

pub fn get_request(conn: &Connection, id: &str) -> rusqlite::Result<Option<AiRequest>> {
    conn.query_row("SELECT * FROM ai_requests WHERE id=?1", params![id], AiRequest::from_row).ok()
}
