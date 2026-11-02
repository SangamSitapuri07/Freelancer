import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./lib/paths.js";

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    key_last4 TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    product TEXT NOT NULL DEFAULT 'GhostGate Client',
    plan TEXT NOT NULL DEFAULT 'standard',
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'suspended', 'revoked')),
    max_devices INTEGER NOT NULL DEFAULT 1
      CHECK (max_devices >= 1 AND max_devices <= 100),
    max_tokens_per_request INTEGER NOT NULL DEFAULT 4096
      CHECK (max_tokens_per_request >= 256 AND max_tokens_per_request <= 32768),
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 20
      CHECK (rate_limit_per_minute >= 1 AND rate_limit_per_minute <= 600),
    credits_total INTEGER NOT NULL DEFAULT 0
      CHECK (credits_total >= 0),
    credits_used INTEGER NOT NULL DEFAULT 0
      CHECK (credits_used >= 0),
    expires_at TEXT,
    notes TEXT,
    created_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS license_devices (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    hwid_hash TEXT NOT NULL,
    hwid_display TEXT NOT NULL,
    device_name TEXT,
    activated_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE (license_id, hwid_hash)
  );

  CREATE TABLE IF NOT EXISTS license_sessions (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES license_devices(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES license_devices(id) ON DELETE SET NULL,
    session_id TEXT REFERENCES license_sessions(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    credits_used INTEGER NOT NULL CHECK (credits_used >= 0),
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    metadata TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_email TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    metadata TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
  CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
  CREATE INDEX IF NOT EXISTS idx_licenses_expiry ON licenses(expires_at);
  CREATE INDEX IF NOT EXISTS idx_license_devices_license ON license_devices(license_id);
  CREATE INDEX IF NOT EXISTS idx_license_sessions_license ON license_sessions(license_id);
  CREATE INDEX IF NOT EXISTS idx_license_sessions_device ON license_sessions(device_id);
  CREATE INDEX IF NOT EXISTS idx_usage_license ON usage_events(license_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
`);

export function closeDb() {
  db.close();
}
