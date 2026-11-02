use hmac::{Hmac, Mac};
use rand::{Rng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

pub fn random_token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("{prefix}{}", hex::encode(bytes))
}

pub fn new_code() -> String {
    format!("{:08}", rand::thread_rng().gen_range(0..100_000_000u32))
}

pub fn is_code(value: &str) -> bool { value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit()) }
pub fn is_device_id(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }
pub fn is_session_token(value: &str) -> bool { value.len() == 70 && value.starts_with("ghost_") && value[6..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }

pub fn sha256_hex(value: &str) -> String { hex::encode(Sha256::digest(value.as_bytes())) }

pub fn hmac_hex(pepper: &[u8], value: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(pepper).expect("HMAC accepts any key length");
    mac.update(value.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn code_hash(code: &str, pepper: &[u8]) -> String { hmac_hex(pepper, &format!("registration:{code}")) }
pub fn privacy_key(value: &str, pepper: &[u8]) -> String { hmac_hex(pepper, value) }
pub fn csrf_token(session_token: &str, pepper: &[u8]) -> String { hmac_hex(pepper, &format!("csrf:{session_token}")) }

pub fn constant_eq(a: &str, b: &str) -> bool {
    let aa = Sha256::digest(a.as_bytes());
    let bb = Sha256::digest(b.as_bytes());
    aa.ct_eq(&bb).into()
}

pub fn cookie_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        if key == name { Some(value.to_string()) } else { None }
    })
}
