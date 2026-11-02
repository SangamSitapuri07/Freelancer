import crypto from "node:crypto";
import { db } from "../db.js";
import { AppError } from "./errors.js";
import {
  addHoursIso,
  adminSessionHours,
  generateToken,
  hashPassword,
  hashToken,
  nowIso,
  randomId,
  verifyPassword,
  verifyPasswordConstantTime,
} from "./utils.js";

export function findAdminByEmail(email) {
  return db
    .prepare("SELECT * FROM admins WHERE email = ?")
    .get(String(email).trim().toLowerCase());
}

export function getAdminById(id) {
  return db.prepare("SELECT * FROM admins WHERE id = ?").get(id);
}

export function createAdmin({ email, password, displayName = "Administrator" }) {
  const normalized = String(email).trim().toLowerCase();
  const existing = findAdminByEmail(normalized);
  if (existing) {
    throw new AppError("An admin with this email already exists", "ADMIN_EXISTS", 409);
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const { hash } = hashPassword(password, salt);
  const id = randomId("adm");

  db.prepare(
    `INSERT INTO admins (id, email, display_name, password_hash, password_salt, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, normalized, displayName, hash, salt, nowIso());

  return { id, email: normalized, displayName };
}

export function authenticateAdmin(email, password) {
  const normalized = String(email).trim().toLowerCase();
  const admin = findAdminByEmail(normalized);

  if (!admin || !admin.is_active) {
    verifyPasswordConstantTime(password);
    return null;
  }

  const valid = verifyPassword(password, admin.password_hash, admin.password_salt);
  if (!valid) return null;

  db.prepare("UPDATE admins SET last_login_at = ? WHERE id = ?").run(nowIso(), admin.id);
  return admin;
}

export function createAdminSession(admin, { ip = null, userAgent = null } = {}) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const id = randomId("asess");
  const expiresAt = addHoursIso(adminSessionHours());

  db.prepare(
    `INSERT INTO admin_sessions
      (id, admin_id, token_hash, expires_at, created_at, last_used_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, admin.id, tokenHash, expiresAt, nowIso(), nowIso(), ip, userAgent);

  return {
    token,
    expiresAt,
    admin: { id: admin.id, email: admin.email, displayName: admin.display_name },
  };
}

export function getAdminSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.admin_id, a.email, a.display_name, a.is_active
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash);

  if (!row || !row.is_active) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  db.prepare("UPDATE admin_sessions SET last_used_at = ? WHERE id = ?").run(nowIso(), row.session_id);

  return {
    sessionId: row.session_id,
    adminId: row.admin_id,
    email: row.email,
    displayName: row.display_name,
    expiresAt: row.expires_at,
  };
}

export function revokeAdminSession(sessionId) {
  db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(sessionId);
}

export function changeAdminPassword(adminId, currentPassword, newPassword) {
  const admin = getAdminById(adminId);
  if (!admin) throw new AppError("Admin not found", "ADMIN_NOT_FOUND", 404);

  if (!verifyPassword(currentPassword, admin.password_hash, admin.password_salt)) {
    throw new AppError("Current password is incorrect", "INVALID_PASSWORD", 401);
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const { hash } = hashPassword(newPassword, salt);

  db.prepare("UPDATE admins SET password_hash = ?, password_salt = ? WHERE id = ?").run(
    hash,
    salt,
    adminId,
  );
  db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").run(adminId);
}

export function ensureAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM admins").get().count;
  if (count > 0) return null;

  const email = process.env.ADMIN_EMAIL?.trim() || "admin@ghostgate.local";
  const password = process.env.ADMIN_PASSWORD?.trim() || "GhostGate!2026";
  const displayName = process.env.ADMIN_NAME?.trim() || "Administrator";

  const admin = createAdmin({ email, password, displayName });

  if (!process.env.ADMIN_PASSWORD?.trim()) {
    console.warn(
      `[ghostgate] No ADMIN_PASSWORD was set. Created ${email} with the default password "${password}". Change it immediately.`,
    );
  } else {
    console.log(`[ghostgate] Initial admin created: ${email}`);
  }

  return admin;
}
