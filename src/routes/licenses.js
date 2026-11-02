import { AppError } from "../lib/errors.js";
import {
  activateLicense,
  consumeCredits,
  getLicenseSession,
  getLicenseUsage,
  releaseDevice,
} from "../lib/licenses.js";
import { requireLicenseSession } from "../lib/middleware.js";
import { rateLimit } from "../lib/rate-limit.js";
import { getAiConfig, hwidIsConfigured, nowIso } from "../lib/utils.js";
import {
  activateSchema,
  releaseDeviceSchema,
  usageSchema,
  validate,
} from "../lib/validation.js";

function licenseSummary(session) {
  return {
    license: session.license,
    device: session.device,
    session: session.session,
    serverTime: nowIso(),
    ai: {
      configured: Boolean(getAiConfig().apiKey),
      model: getAiConfig().model,
      creditsPerRequest: getAiConfig().creditsPerRequest,
      tokensPerCredit: getAiConfig().tokensPerCredit,
    },
  };
}

export function registerLicenseRoutes(app) {
  app.post("/v1/licenses/activate", async (request, reply) => {
    const limit = rateLimit(`activate:${request.ip}`, 20, 60_000);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(limit.retryAfterSeconds))
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many activation attempts. Try again shortly.",
          },
        });
    }

    const body = validate(activateSchema, request.body);
    const result = activateLicense({
      licenseKey: body.licenseKey,
      hwid: body.hwid,
      deviceName: body.deviceName,
      ip: request.ip,
    });

    return reply.code(201).send(result);
  });

  app.get("/v1/license", { preHandler: requireLicenseSession }, async (request) => {
    return licenseSummary(request.licenseSession);
  });

  app.post("/v1/license/heartbeat", { preHandler: requireLicenseSession }, async (request) => {
    return licenseSummary(request.licenseSession);
  });

  app.get("/v1/license/usage", { preHandler: requireLicenseSession }, async (request) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
    return {
      usage: getLicenseUsage(request.licenseSession.license.id, limit),
      serverTime: nowIso(),
    };
  });

  app.post(
    "/v1/license/devices/release",
    { preHandler: requireLicenseSession },
    async (request, reply) => {
      const body = validate(releaseDeviceSchema, request.body);
      const result = releaseDevice(
        request.licenseSession.license.id,
        body.deviceId,
        request.ip,
      );
      return reply.send(result);
    },
  );

  app.post("/v1/usage", { preHandler: requireLicenseSession }, async (request, reply) => {
    const body = validate(usageSchema, request.body);
    const session = request.licenseSession;

    const result = consumeCredits({
      licenseId: session.license.id,
      deviceId: session.device.id,
      sessionId: session.session.id,
      kind: body.kind,
      credits: body.credits,
      tokensIn: body.tokensIn,
      tokensOut: body.tokensOut,
      model: "client-reported",
      metadata: body.metadata || null,
      ip: request.ip,
    });

    return reply.send({
      creditsUsed: result.creditsUsed,
      creditsRemaining: result.creditsRemaining,
      usageId: result.usageId,
    });
  });

  app.get("/v1/health", async () => {
    return {
      status: "ok",
      service: "ghostgate",
      version: "1.0.0",
      time: nowIso(),
      database: "ok",
      aiConfigured: Boolean(getAiConfig().apiKey),
      hwidPepperConfigured: hwidIsConfigured(),
    };
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/v1/")) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "API route not found" },
      });
    }
    return reply.code(404).send({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });
}
