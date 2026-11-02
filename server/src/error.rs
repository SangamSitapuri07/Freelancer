use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub uncertain: bool,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), uncertain: false }
    }
    pub fn bad_request(message: impl Into<String>) -> Self { Self::new(StatusCode::BAD_REQUEST, "invalid_request", message) }
    pub fn unauthorized(code: &'static str, message: impl Into<String>) -> Self { Self::new(StatusCode::UNAUTHORIZED, code, message) }
    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self { Self::new(StatusCode::FORBIDDEN, code, message) }
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self { Self::new(StatusCode::CONFLICT, code, message) }
    pub fn uncertain(message: impl Into<String>) -> Self {
        Self { status: StatusCode::CONFLICT, code: "request_uncertain", message: message.into(), uncertain: true }
    }
    pub fn internal() -> Self { Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "The server could not complete the request") }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.code, self.message) }
}
impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": {"code": self.code, "message": self.message}}))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(value: rusqlite::Error) -> Self { tracing::error!(error=%value, "database error"); Self::internal() }
}
impl From<serde_json::Error> for ApiError {
    fn from(value: serde_json::Error) -> Self { tracing::error!(error=%value, "JSON error"); Self::internal() }
}

pub fn ensure(condition: bool, error: ApiError) -> Result<(), ApiError> {
    if condition { Ok(()) } else { Err(error) }
}
