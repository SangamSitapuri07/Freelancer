use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct License {
    pub id: String,
    pub label: String,
    pub token_limit: i64,
    pub request_limit: i64,
    pub tokens_used: i64,
    pub requests_used: i64,
    pub reserved_tokens: i64,
    pub reserved_requests: i64,
    pub device_id: Option<String>,
    pub device_bound_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

impl License {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?, label: row.get("label")?,
            token_limit: row.get("token_limit")?, request_limit: row.get("request_limit")?,
            tokens_used: row.get("tokens_used")?, requests_used: row.get("requests_used")?,
            reserved_tokens: row.get("reserved_tokens")?, reserved_requests: row.get("reserved_requests")?,
            device_id: row.get("device_id")?, device_bound_at: row.get("device_bound_at")?,
            expires_at: row.get("expires_at")?, revoked_at: row.get("revoked_at")?,
            created_at: row.get("created_at")?, last_seen_at: row.get("last_seen_at")?,
        })
    }
    pub fn quota(&self) -> Quota {
        Quota {
            license_id: self.id.clone(), label: self.label.clone(),
            token_limit: self.token_limit, request_limit: self.request_limit,
            tokens_used: self.tokens_used, requests_used: self.requests_used,
            tokens_remaining: (self.token_limit - self.tokens_used - self.reserved_tokens).max(0),
            requests_remaining: (self.request_limit - self.requests_used - self.reserved_requests).max(0),
            reserved_tokens: self.reserved_tokens, reserved_requests: self.reserved_requests,
            expires_at: self.expires_at.clone(), revoked: self.revoked_at.is_some(),
            device_bound: self.device_id.is_some(),
        }
    }
    pub fn active(&self) -> bool {
        self.revoked_at.is_none() && self.expires_at.as_deref().map(|e| e > crate::db::now().as_str()).unwrap_or(true)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Quota {
    pub license_id: String,
    pub label: String,
    pub token_limit: i64,
    pub request_limit: i64,
    pub tokens_used: i64,
    pub requests_used: i64,
    pub tokens_remaining: i64,
    pub requests_remaining: i64,
    pub reserved_tokens: i64,
    pub reserved_requests: i64,
    pub expires_at: Option<String>,
    pub revoked: bool,
    pub device_bound: bool,
}

#[derive(Debug, Deserialize)]
pub struct ActivateRequest { pub code: String, pub device_id: String }

#[derive(Debug, Serialize)]
pub struct ActivateResponse { pub session_token: String, pub session_expires_at: String, pub license: Quota }

#[derive(Debug, Deserialize)]
pub struct AssistRequest { pub language: String, pub images: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage { pub prompt_tokens: i64, pub completion_tokens: i64, pub total_tokens: i64 }

#[derive(Debug, Serialize)]
pub struct AssistResponse { pub answer: String, pub usage: Usage, pub request_id: String, pub license: Quota }

#[derive(Debug, Clone)]
pub struct AiRequest {
    pub id: String,
    pub license_id: String,
    pub payload_hash: String,
    pub status: String,
    pub reserved_tokens: i64,
    pub actual_tokens: Option<i64>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub response: Option<String>,
    pub error_code: Option<String>,
    pub http_status: Option<i64>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

impl AiRequest {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?, license_id: row.get("license_id")?, payload_hash: row.get("payload_hash")?,
            status: row.get("status")?, reserved_tokens: row.get("reserved_tokens")?, actual_tokens: row.get("actual_tokens")?,
            prompt_tokens: row.get("prompt_tokens")?, completion_tokens: row.get("completion_tokens")?,
            response: row.get("response")?, error_code: row.get("error_code")?, http_status: row.get("http_status")?,
            created_at: row.get("created_at")?, completed_at: row.get("completed_at")?,
        })
    }
}
