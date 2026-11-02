import { db } from "../db.js";
import { nowIso, randomId } from "./utils.js";

export function logAudit({
  actorType,
  actorId = null,
  actorEmail = null,
  action,
  entityType = null,
  entityId = null,
  metadata = null,
  ip = null,
}) {
  db.prepare(
    `INSERT INTO audit_logs
      (id, actor_type, actor_id, actor_email, action, entity_type, entity_id, metadata, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomId("aud"),
    actorType,
    actorId,
    actorEmail,
    action,
    entityType,
    entityId,
    metadata === undefined || metadata === null ? null : JSON.stringify(metadata),
    ip,
    nowIso(),
  );
}

export function getAuditLogs({ limit = 100, offset = 0, search = "" } = {}) {
  const term = search.trim();
  const where = term
    ? `WHERE actor_email LIKE ? OR action LIKE ? OR entity_id LIKE ? OR metadata LIKE ?`
    : "";
  const params = term ? [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`] : [];

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`)
    .get(...params).count;

  const rows = db
    .prepare(
      `SELECT * FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  return {
    total,
    logs: rows.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    })),
  };
}
