import { getAuditLogs } from "../lib/audit.js";
import {
  authenticateAdmin,
  changeAdminPassword,
  createAdminSession,
  revokeAdminSession,
} from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import {
  addCredits,
  createLicense,
  exportLicenses,
  getLicenseAudit,
  getLicenseById,
  getLicenseUsage,
  getStats,
  listLicenses,
  setLicenseStatus,
  unbindDevice,
  updateLicense,
} from "../lib/licenses.js";
import { requireAdmin } from "../lib/middleware.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  adminSessionHours,
  getAiConfig,
  hwidIsConfigured,
  nowIso,
  sessionHours,
} from "../lib/utils.js";
import {
  addCreditsSchema,
  adminLoginSchema,
  auditQuerySchema,
  changePasswordSchema,
  createLicenseSchema,
  licenseStatusSchema,
  paginationSchema,
  updateLicenseSchema,
  validate,
} from "../lib/validation.js";

function adminActor(request) {
  return {
    id: request.adminSession.adminId,
    email: request.adminSession.email,
    ip: request.ip,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function registerAdminRoutes(app) {
  app.post("/v1/admin/login", async (request, reply) => {
    const limit = rateLimit(`admin-login:${request.ip}`, 10, 60_000);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(limit.retryAfterSeconds))
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many sign-in attempts. Try again shortly.",
          },
        });
    }

    const body = validate(adminLoginSchema, request.body);
    const admin = authenticateAdmin(body.email, body.password);
    if (!admin) {
      throw new AppError("Invalid email or password", "INVALID_CREDENTIALS", 401);
    }

    const session = createAdminSession(admin, {
      ip: request.ip,
      userAgent: request.headers["user-agent"] || null,
    });

    return reply.send({
      token: session.token,
      expiresAt: session.expiresAt,
      admin: session.admin,
    });
  });

  app.get("/v1/admin/me", { preHandler: requireAdmin }, async (request) => {
    return {
      admin: {
        id: request.adminSession.adminId,
        email: request.adminSession.email,
        displayName: request.adminSession.displayName,
        expiresAt: request.adminSession.expiresAt,
      },
      serverTime: nowIso(),
    };
  });

  app.post("/v1/admin/logout", { preHandler: requireAdmin }, async (request, reply) => {
    revokeAdminSession(request.adminSession.sessionId);
    return reply.send({ ok: true });
  });

  app.post("/v1/admin/password", { preHandler: requireAdmin }, async (request, reply) => {
    const body = validate(changePasswordSchema, request.body);
    changeAdminPassword(request.adminSession.adminId, body.currentPassword, body.newPassword);
    return reply.send({ ok: true });
  });

  app.get("/v1/admin/stats", { preHandler: requireAdmin }, async () => {
    return getStats();
  });

  app.get("/v1/admin/licenses", { preHandler: requireAdmin }, async (request) => {
    const pagination = validate(paginationSchema, request.query);
    const search = typeof request.query.search === "string" ? request.query.search : "";
    const status = typeof request.query.status === "string" ? request.query.status : "all";
    return listLicenses({
      search,
      status,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });
  });

  app.post("/v1/admin/licenses", { preHandler: requireAdmin }, async (request, reply) => {
    const body = validate(createLicenseSchema, request.body);
    const result = createLicense({ admin: adminActor(request), ...body });
    return reply.code(201).send({
      license: result.license,
      licenseKey: result.licenseKey,
    });
  });

  app.get("/v1/admin/licenses/:id", { preHandler: requireAdmin }, async (request) => {
    return getLicenseById(request.params.id);
  });

  app.patch("/v1/admin/licenses/:id", { preHandler: requireAdmin }, async (request) => {
    const body = validate(updateLicenseSchema, request.body);
    return updateLicense(request.params.id, body, adminActor(request));
  });

  app.post("/v1/admin/licenses/:id/credits", { preHandler: requireAdmin }, async (request) => {
    const body = validate(addCreditsSchema, request.body);
    return addCredits(request.params.id, body.amount, body.reason, adminActor(request));
  });

  app.post("/v1/admin/licenses/:id/status", { preHandler: requireAdmin }, async (request) => {
    const body = validate(licenseStatusSchema, request.body);
    return setLicenseStatus(request.params.id, body.status, adminActor(request));
  });

  app.delete(
    "/v1/admin/licenses/:id/devices/:deviceId",
    { preHandler: requireAdmin },
    async (request) => {
      return unbindDevice(request.params.id, request.params.deviceId, adminActor(request));
    },
  );

  app.get("/v1/admin/licenses/:id/usage", { preHandler: requireAdmin }, async (request) => {
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    return { usage: getLicenseUsage(request.params.id, limit) };
  });

  app.get("/v1/admin/licenses/:id/audit", { preHandler: requireAdmin }, async (request) => {
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    return { auditLogs: getLicenseAudit(request.params.id, limit) };
  });

  app.get("/v1/admin/audit-logs", { preHandler: requireAdmin }, async (request) => {
    const query = validate(auditQuerySchema, request.query);
    return getAuditLogs(query);
  });

  app.get("/v1/admin/export", { preHandler: requireAdmin }, async (request, reply) => {
    const rows = exportLicenses();
    const headers = [
      "id",
      "key",
      "customer_name",
      "customer_email",
      "product",
      "plan",
      "status",
      "max_devices",
      "max_tokens_per_request",
      "rate_limit_per_minute",
      "credits_total",
      "credits_used",
      "credits_remaining",
      "expires_at",
      "created_at",
    ];

    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.keyMasked,
          row.customerName,
          row.customerEmail,
          row.product,
          row.plan,
          row.status,
          row.maxDevices,
          row.maxTokensPerRequest,
          row.rateLimitPerMinute,
          row.creditsTotal,
          row.creditsUsed,
          row.creditsRemaining,
          row.expiresAt,
          row.createdAt,
        ]
          .map(csvCell)
          .join(","),
      );
    }

    return reply
      .code(200)
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="ghostgate-licenses.csv"')
      .send(`\uFEFF${lines.join("\r\n")}`);
  });

  app.get("/v1/admin/settings", { preHandler: requireAdmin }, async () => {
    const ai = getAiConfig();
    return {
      version: "1.0.0",
      serverTime: nowIso(),
      ai: {
        configured: Boolean(ai.apiKey),
        model: ai.model,
        baseUrl: ai.baseUrl,
        creditsPerRequest: ai.creditsPerRequest,
        tokensPerCredit: ai.tokensPerCredit,
      },
      security: {
        hwidPepperConfigured: hwidIsConfigured(),
        sessionHours: sessionHours(),
        adminSessionHours: adminSessionHours(),
      },
    };
  });
}
