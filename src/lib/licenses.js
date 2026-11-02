import { db } from "../db.js";
import { AppError } from "./errors.js";
import { logAudit } from "./audit.js";
import { withTransaction } from "./transaction.js";
import {
  addDaysIso,
  addHoursIso,
  daysAgoIso,
  generateLicenseKey,
  generateToken,
  hashHwid,
  hashToken,
  hwidDisplay,
  isPast,
  normalizeLicenseKey,
  nowIso,
  randomId,
  sessionHours,
  sha256,
} from "./utils.js";

function publicUsage(row) {
  return {
    id: row.id,
    kind: row.kind,
    creditsUsed: row.credits_used,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    model: row.model,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    ip: row.ip,
    createdAt: row.created_at,
  };
}

function publicAuditLog(row) {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    ip: row.ip,
    createdAt: row.created_at,
  };
}

function publicDevice(row) {
  return {
    id: row.id,
    deviceName: row.device_name,
    hwidDisplay: row.hwid_display,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function publicLicense(row, extras = {}) {
  const creditsRemaining = Math.max(0, row.credits_total - row.credits_used);
  const expired = row.expires_at ? isPast(row.expires_at) : false;
  const expiringSoon =
    row.expires_at &&
    !expired &&
    new Date(row.expires_at).getTime() <= Date.now() + 7 * 24 * 60 * 60 * 1000;

  return {
    id: row.id,
    keyMasked: `${row.key_prefix}-••••-••••-••••-${row.key_last4}`,
    keyLast4: row.key_last4,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    product: row.product,
    plan: row.plan,
    status: row.status,
    maxDevices: row.max_devices,
    maxTokensPerRequest: row.max_tokens_per_request,
    rateLimitPerMinute: row.rate_limit_per_minute,
    creditsTotal: row.credits_total,
    creditsUsed: row.credits_used,
    creditsRemaining,
    expiresAt: row.expires_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expired,
    expiringSoon: Boolean(expiringSoon),
    ...extras,
  };
}

function countActiveDevices(licenseId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS count FROM license_devices WHERE license_id = ? AND revoked_at IS NULL",
    )
    .get(licenseId).count;
}

function countActiveSessions(licenseId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS count FROM license_sessions WHERE license_id = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .get(licenseId, nowIso()).count;
}

export function createLicense({ admin, customerName, customerEmail, product, plan, maxDevices, maxTokensPerRequest, rateLimitPerMinute, credits, expiresInDays, notes }) {
  const licenseKey = generateLicenseKey();
  const id = randomId("lic");
  const now = nowIso();
  const expiresAt = addDaysIso(expiresInDays);

  db.prepare(
    `INSERT INTO licenses
      (id, key_hash, key_prefix, key_last4, customer_name, customer_email, product, plan, status,
       max_devices, max_tokens_per_request, rate_limit_per_minute, credits_total, credits_used,
       expires_at, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sha256(licenseKey),
    licenseKey.slice(0, 2),
    licenseKey.slice(-4),
    customerName,
    customerEmail || null,
    product,
    plan,
    maxDevices,
    maxTokensPerRequest,
    rateLimitPerMinute,
    credits,
    expiresAt,
    notes || null,
    admin.id,
    now,
    now,
  );

  const row = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id);
  logAudit({
    actorType: "admin",
    actorId: admin.id,
    actorEmail: admin.email,
    action: "LICENSE_CREATED",
    entityType: "license",
    entityId: id,
    metadata: { credits, maxDevices, expiresAt, plan },
    ip: admin.ip || null,
  });

  return {
    license: publicLicense(row, { devicesUsed: 0, activeSessions: 0 }),
    licenseKey,
  };
}

export function listLicenses({ search = "", status = "all", page = 1, pageSize = 20 } = {}) {
  const where = [];
  const params = [];
  const term = search.trim();

  if (term) {
    where.push(
      "(l.customer_name LIKE ? OR l.customer_email LIKE ? OR l.key_last4 LIKE ? OR l.product LIKE ?)",
    );
    const like = `%${term}%`;
    params.push(like, like, like, like);
  }

  if (status && status !== "all") {
    where.push("l.status = ?");
    params.push(status);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM licenses l ${whereSql}`)
    .get(...params).count;

  const rows = db
    .prepare(
      `SELECT l.*,
         (SELECT COUNT(*) FROM license_devices d WHERE d.license_id = l.id AND d.revoked_at IS NULL) AS devices_used,
         (SELECT COUNT(*) FROM license_sessions s WHERE s.license_id = l.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
       FROM licenses l
       ${whereSql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, nowIso(), pageSize, (page - 1) * pageSize);

  return {
    total,
    page,
    pageSize,
    licenses: rows.map((row) =>
      publicLicense(row, {
        devicesUsed: row.devices_used,
        activeSessions: row.active_sessions,
      }),
    ),
  };
}

export function getLicenseUsage(licenseId, limit = 50) {
  return db
    .prepare("SELECT * FROM usage_events WHERE license_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(licenseId, limit)
    .map(publicUsage);
}

export function getLicenseAudit(licenseId, limit = 50) {
  return db
    .prepare(
      "SELECT * FROM audit_logs WHERE entity_type = 'license' AND entity_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(licenseId, limit)
    .map(publicAuditLog);
}

export function getLicenseById(id) {
  const row = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id);
  if (!row) throw new AppError("License not found", "LICENSE_NOT_FOUND", 404);

  const devices = db
    .prepare("SELECT * FROM license_devices WHERE license_id = ? ORDER BY activated_at DESC")
    .all(id)
    .map(publicDevice);

  const usage = getLicenseUsage(id, 20);
  const auditLogs = getLicenseAudit(id, 20);

  return {
    license: publicLicense(row, {
      devicesUsed: devices.filter((device) => !device.revokedAt).length,
      activeSessions: countActiveSessions(id),
    }),
    devices,
    usage,
    auditLogs,
  };
}

export function updateLicense(id, patch, admin) {
  const existing = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id);
  if (!existing) throw new AppError("License not found", "LICENSE_NOT_FOUND", 404);

  const fields = [];
  const params = [];

  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.customerName !== undefined) set("customer_name", patch.customerName);
  if (patch.customerEmail !== undefined) set("customer_email", patch.customerEmail || null);
  if (patch.product !== undefined) set("product", patch.product);
  if (patch.plan !== undefined) set("plan", patch.plan);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.maxDevices !== undefined) set("max_devices", patch.maxDevices);
  if (patch.maxTokensPerRequest !== undefined) set("max_tokens_per_request", patch.maxTokensPerRequest);
  if (patch.rateLimitPerMinute !== undefined) set("rate_limit_per_minute", patch.rateLimitPerMinute);
  if (patch.creditsTotal !== undefined) {
    if (patch.creditsTotal < existing.credits_used) {
      throw new AppError(
        "Credits total cannot be lower than credits already used",
        "CREDITS_BELOW_USED",
        400,
        { creditsUsed: existing.credits_used, requested: patch.creditsTotal },
      );
    }
    set("credits_total", patch.creditsTotal);
  }
  if (patch.expiresAt !== undefined) set("expires_at", patch.expiresAt);
  if (patch.notes !== undefined) set("notes", patch.notes || null);

  if (!fields.length) {
    throw new AppError("No fields to update", "NO_FIELDS", 400);
  }

  set("updated_at", nowIso());

  db.prepare(`UPDATE licenses SET ${fields.join(", ")} WHERE id = ?`).run(...params, id);

  if (patch.status && patch.status !== "active") {
    db.prepare(
      "UPDATE license_sessions SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL",
    ).run(nowIso(), id);
  }

  logAudit({
    actorType: "admin",
    actorId: admin.id,
    actorEmail: admin.email,
    action: "LICENSE_UPDATED",
    entityType: "license",
    entityId: id,
    metadata: { changed: Object.keys(patch), status: patch.status || existing.status },
    ip: admin.ip || null,
  });

  return getLicenseById(id);
}

export function addCredits(id, amount, reason, admin) {
  const existing = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id);
  if (!existing) throw new AppError("License not found", "LICENSE_NOT_FOUND", 404);

  const nextTotal = existing.credits_total + amount;
  if (nextTotal < existing.credits_used) {
    throw new AppError(
      "Adjustment would leave fewer total credits than already used",
      "CREDITS_BELOW_USED",
      400,
      { creditsUsed: existing.credits_used, requestedTotal: nextTotal },
    );
  }

  db.prepare("UPDATE licenses SET credits_total = ?, updated_at = ? WHERE id = ?").run(
    nextTotal,
    nowIso(),
    id,
  );

  logAudit({
    actorType: "admin",
    actorId: admin.id,
    actorEmail: admin.email,
    action: "CREDITS_ADDED",
    entityType: "license",
    entityId: id,
    metadata: { amount, reason: reason || null, creditsTotal: nextTotal },
    ip: admin.ip || null,
  });

  return getLicenseById(id);
}

export function setLicenseStatus(id, status, admin) {
  const existing = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id);
  if (!existing) throw new AppError("License not found", "LICENSE_NOT_FOUND", 404);

  db.prepare("UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowIso(),
    id,
  );

  if (status !== "active") {
    db.prepare(
      "UPDATE license_sessions SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL",
    ).run(nowIso(), id);
  }

  logAudit({
    actorType: "admin",
    actorId: admin.id,
    actorEmail: admin.email,
    action: "LICENSE_STATUS_CHANGED",
    entityType: "license",
    entityId: id,
    metadata: { from: existing.status, to: status },
    ip: admin.ip || null,
  });

  return getLicenseById(id);
}

export function unbindDevice(licenseId, deviceId, admin) {
  const device = db.prepare("SELECT * FROM license_devices WHERE id = ?").get(deviceId);
  if (!device || device.license_id !== licenseId) {
    throw new AppError("Device not found for this license", "DEVICE_NOT_FOUND", 404);
  }

  const now = nowIso();
  db.prepare("UPDATE license_devices SET revoked_at = ? WHERE id = ?").run(now, deviceId);
  db.prepare(
    "UPDATE license_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
  ).run(now, deviceId);

  logAudit({
    actorType: "admin",
    actorId: admin.id,
    actorEmail: admin.email,
    action: "DEVICE_UNBOUND",
    entityType: "license",
    entityId: licenseId,
    metadata: { deviceId, hwidDisplay: device.hwid_display, deviceName: device.device_name },
    ip: admin.ip || null,
  });

  return getLicenseById(licenseId);
}

export function activateLicense({ licenseKey, hwid, deviceName, ip = null }) {
  const normalized = normalizeLicenseKey(licenseKey);
  if (!normalized) {
    throw new AppError("License key format is invalid", "INVALID_LICENSE_FORMAT", 400);
  }

  const license = db.prepare("SELECT * FROM licenses WHERE key_hash = ?").get(sha256(normalized));
  if (!license) {
    throw new AppError("License key is not valid", "INVALID_LICENSE", 401);
  }
  if (license.status === "revoked") {
    throw new AppError("This license has been revoked", "LICENSE_REVOKED", 403);
  }
  if (license.status === "suspended") {
    throw new AppError("This license is suspended", "LICENSE_SUSPENDED", 403);
  }
  if (license.expires_at && isPast(license.expires_at)) {
    throw new AppError("This license has expired", "LICENSE_EXPIRED", 403);
  }
  if (license.credits_total - license.credits_used <= 0) {
    throw new AppError("This license has no credits remaining", "NO_CREDITS", 402, {
      creditsRemaining: 0,
    });
  }

  const hwidHash = hashHwid(hwid);
  const display = hwidDisplay(hwid);
  const now = nowIso();
  const device = db
    .prepare("SELECT * FROM license_devices WHERE license_id = ? AND hwid_hash = ?")
    .get(license.id, hwidHash);

  let deviceRow;

  if (device) {
    db.prepare(
      "UPDATE license_devices SET revoked_at = NULL, activated_at = ?, last_seen_at = ?, device_name = ? WHERE id = ?",
    ).run(now, now, deviceName || device.device_name, device.id);
    deviceRow = db.prepare("SELECT * FROM license_devices WHERE id = ?").get(device.id);
  } else {
    const activeDevices = countActiveDevices(license.id);
    if (activeDevices >= license.max_devices) {
      throw new AppError(
        "Device limit reached for this license. Ask the admin to unbind a device.",
        "DEVICE_LIMIT_REACHED",
        409,
        { activeDevices, maxDevices: license.max_devices },
      );
    }

    const deviceId = randomId("dev");
    db.prepare(
      `INSERT INTO license_devices
        (id, license_id, hwid_hash, hwid_display, device_name, activated_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(deviceId, license.id, hwidHash, display, deviceName || "Unnamed device", now, now);
    deviceRow = db.prepare("SELECT * FROM license_devices WHERE id = ?").get(deviceId);
  }

  const sessionToken = generateToken();
  const sessionExpiresAt = addHoursIso(sessionHours());
  const sessionId = randomId("sess");

  db.prepare(
    `INSERT INTO license_sessions
      (id, license_id, device_id, token_hash, expires_at, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(sessionId, license.id, deviceRow.id, hashToken(sessionToken), sessionExpiresAt, now, now);

  logAudit({
    actorType: "license",
    actorId: license.id,
    actorEmail: license.customer_email,
    action: "LICENSE_ACTIVATED",
    entityType: "license",
    entityId: license.id,
    metadata: { deviceId: deviceRow.id, hwidDisplay: display, deviceName: deviceRow.device_name },
    ip,
  });

  return {
    sessionToken,
    expiresAt: sessionExpiresAt,
    license: publicLicense(license, {
      devicesUsed: countActiveDevices(license.id),
      activeSessions: countActiveSessions(license.id),
    }),
    device: publicDevice(deviceRow),
  };
}

export function getLicenseSession(token) {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT
         s.id AS session_id,
         s.expires_at AS session_expires_at,
         s.created_at AS session_created_at,
         s.last_used_at AS session_last_used_at,
         s.revoked_at AS session_revoked_at,
         l.*,
         d.id AS device_id,
         d.device_name,
         d.hwid_display,
         d.activated_at AS device_activated_at,
         d.last_seen_at AS device_last_seen_at,
         d.revoked_at AS device_revoked_at
       FROM license_sessions s
       JOIN licenses l ON l.id = s.license_id
       JOIN license_devices d ON d.id = s.device_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));

  if (!row) return null;
  if (row.session_revoked_at) return null;
  if (isPast(row.session_expires_at)) return null;
  if (row.device_revoked_at) return null;
  if (row.status !== "active") return null;
  if (row.expires_at && isPast(row.expires_at)) return null;

  const now = nowIso();
  db.prepare("UPDATE license_sessions SET last_used_at = ? WHERE id = ?").run(now, row.session_id);
  db.prepare("UPDATE license_devices SET last_seen_at = ? WHERE id = ?").run(now, row.device_id);

  return {
    session: {
      id: row.session_id,
      expiresAt: row.session_expires_at,
      createdAt: row.session_created_at,
      lastUsedAt: now,
      revokedAt: row.session_revoked_at,
    },
    license: publicLicense(row, {
      devicesUsed: countActiveDevices(row.id),
      activeSessions: countActiveSessions(row.id),
    }),
    device: {
      id: row.device_id,
      deviceName: row.device_name,
      hwidDisplay: row.hwid_display,
      activatedAt: row.device_activated_at,
      lastSeenAt: now,
      revokedAt: row.device_revoked_at,
    },
  };
}

export function releaseDevice(licenseId, deviceId, ip = null) {
  const device = db.prepare("SELECT * FROM license_devices WHERE id = ?").get(deviceId);
  if (!device || device.license_id !== licenseId) {
    throw new AppError("Device not found for this license", "DEVICE_NOT_FOUND", 404);
  }

  const now = nowIso();
  db.prepare("UPDATE license_devices SET revoked_at = ? WHERE id = ?").run(now, deviceId);
  db.prepare(
    "UPDATE license_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
  ).run(now, deviceId);

  logAudit({
    actorType: "license",
    actorId: licenseId,
    action: "DEVICE_RELEASED",
    entityType: "license",
    entityId: licenseId,
    metadata: { deviceId, hwidDisplay: device.hwid_display, deviceName: device.device_name },
    ip,
  });

  return { ok: true };
}

export function consumeCredits({
  licenseId,
  deviceId,
  sessionId,
  kind,
  credits,
  tokensIn = 0,
  tokensOut = 0,
  model = null,
  metadata = null,
  ip = null,
}) {
  return withTransaction(() => {
    const license = db.prepare("SELECT * FROM licenses WHERE id = ?").get(licenseId);
    if (!license) throw new AppError("License not found", "LICENSE_NOT_FOUND", 404);
    if (license.status !== "active") {
      throw new AppError("License is not active", "LICENSE_INACTIVE", 403);
    }
    if (license.expires_at && isPast(license.expires_at)) {
      throw new AppError("License has expired", "LICENSE_EXPIRED", 403);
    }

    const remaining = license.credits_total - license.credits_used;
    if (remaining < credits) {
      throw new AppError("Insufficient credits", "INSUFFICIENT_CREDITS", 402, {
        required: credits,
        available: remaining,
      });
    }

    const now = nowIso();
    db.prepare("UPDATE licenses SET credits_used = credits_used + ?, updated_at = ? WHERE id = ?").run(
      credits,
      now,
      licenseId,
    );

    const usageId = randomId("use");
    db.prepare(
      `INSERT INTO usage_events
        (id, license_id, device_id, session_id, kind, credits_used, tokens_in, tokens_out, model, metadata, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      usageId,
      licenseId,
      deviceId,
      sessionId,
      kind,
      credits,
      tokensIn,
      tokensOut,
      model,
      metadata ? JSON.stringify(metadata) : null,
      ip,
      now,
    );

    return {
      usageId,
      creditsUsed: credits,
      creditsRemaining: remaining - credits,
    };
  });
}

export function getStats() {
  const now = nowIso();
  const inSevenDays = addDaysIso(7);
  const thirtyDaysAgo = daysAgoIso(30);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const licenseStats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
         SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
         SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ? THEN 1 ELSE 0 END) AS expiring_soon,
         SUM(credits_total - credits_used) AS credits_remaining,
         SUM(credits_used) AS credits_used,
         SUM(credits_total) AS credits_total
       FROM licenses`,
    )
    .get(now, now, inSevenDays);

  const deviceCount = db
    .prepare("SELECT COUNT(*) AS count FROM license_devices WHERE revoked_at IS NULL")
    .get().count;

  const activeSessions = db
    .prepare(
      "SELECT COUNT(*) AS count FROM license_sessions WHERE revoked_at IS NULL AND expires_at > ?",
    )
    .get(now).count;

  const usage30 = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(credits_used), 0) AS credits,
              COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens
       FROM usage_events
       WHERE created_at >= ?`,
    )
    .get(thirtyDaysAgo);

  const usageToday = db
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(credits_used), 0) AS credits
       FROM usage_events
       WHERE created_at >= ?`,
    )
    .get(startOfDay.toISOString());

  const byDay = new Map(
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                COALESCE(SUM(credits_used), 0) AS credits,
                COUNT(*) AS requests
         FROM usage_events
         WHERE created_at >= ?
         GROUP BY day
         ORDER BY day`,
      )
      .all(thirtyDaysAgo)
      .map((row) => [row.day, row]),
  );

  const usageByDay = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const key = day.toISOString().slice(0, 10);
    const found = byDay.get(key);
    usageByDay.push({
      date: key,
      credits: found?.credits || 0,
      requests: found?.requests || 0,
    });
  }

  const topLicenses = db
    .prepare(
      `SELECT l.id, l.customer_name, l.product, l.plan,
              COALESCE(SUM(u.credits_used), 0) AS credits,
              COUNT(u.id) AS requests
       FROM usage_events u
       JOIN licenses l ON l.id = u.license_id
       WHERE u.created_at >= ?
       GROUP BY l.id
       ORDER BY credits DESC
       LIMIT 5`,
    )
    .all(thirtyDaysAgo);

  const planMix = db
    .prepare("SELECT plan, COUNT(*) AS count FROM licenses GROUP BY plan ORDER BY count DESC")
    .all();

  return {
    totalLicenses: licenseStats.total || 0,
    activeLicenses: licenseStats.active || 0,
    suspendedLicenses: licenseStats.suspended || 0,
    revokedLicenses: licenseStats.revoked || 0,
    expiredLicenses: licenseStats.expired || 0,
    expiringSoonLicenses: licenseStats.expiring_soon || 0,
    totalDevices: deviceCount,
    activeSessions,
    creditsRemaining: licenseStats.credits_remaining || 0,
    creditsUsed: licenseStats.credits_used || 0,
    creditsTotal: licenseStats.credits_total || 0,
    requests30d: usage30.requests || 0,
    creditsUsed30d: usage30.credits || 0,
    tokens30d: usage30.tokens || 0,
    requestsToday: usageToday.requests || 0,
    creditsToday: usageToday.credits || 0,
    usageByDay,
    topLicenses,
    planMix,
  };
}

export function exportLicenses() {
  return db
    .prepare(
      `SELECT l.*,
         (SELECT COUNT(*) FROM license_devices d WHERE d.license_id = l.id AND d.revoked_at IS NULL) AS devices_used
       FROM licenses l
       ORDER BY l.created_at DESC`,
    )
    .all()
    .map((row) => publicLicense(row, { devicesUsed: row.devices_used }));
}
