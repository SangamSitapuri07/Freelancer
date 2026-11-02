import { createChatCompletion } from "../lib/ai.js";
import { computeCreditCost } from "../lib/credits.js";
import { AppError } from "../lib/errors.js";
import { consumeCredits, getLicenseSession } from "../lib/licenses.js";
import { withLock } from "../lib/lock.js";
import { requireLicenseSession } from "../lib/middleware.js";
import { rateLimit } from "../lib/rate-limit.js";
import { getAiConfig } from "../lib/utils.js";
import { aiCompletionSchema, validate } from "../lib/validation.js";

function tokenFromRequest(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function registerAiRoutes(app) {
  app.get("/v1/ai/config", { preHandler: requireLicenseSession }, async (request) => {
    const config = getAiConfig();
    const license = request.licenseSession.license;
    return {
      model: config.model,
      creditsPerRequest: config.creditsPerRequest,
      tokensPerCredit: config.tokensPerCredit,
      maxTokensPerRequest: license.maxTokensPerRequest,
      rateLimitPerMinute: license.rateLimitPerMinute,
    };
  });

  app.post("/v1/ai/completions", { preHandler: requireLicenseSession }, async (request, reply) => {
    const session = request.licenseSession;
    const license = session.license;
    const token = tokenFromRequest(request);

    if (!token) {
      throw new AppError("License session token is missing", "LICENSE_SESSION_INVALID", 401);
    }

    const licenseLimit = rateLimit(
      `ai-license:${license.id}`,
      license.rateLimitPerMinute,
      60_000,
    );
    if (!licenseLimit.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(licenseLimit.retryAfterSeconds))
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "This license has reached its per-minute request limit.",
          },
        });
    }

    const ipLimit = rateLimit(`ai-ip:${request.ip}`, 60, 60_000);
    if (!ipLimit.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(ipLimit.retryAfterSeconds))
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many AI requests from this network. Try again shortly.",
          },
        });
    }

    const body = validate(aiCompletionSchema, request.body);
    const maxTokens = Math.min(body.maxTokens ?? 2048, license.maxTokensPerRequest);

    const result = await withLock(license.id, async () => {
      const fresh = getLicenseSession(token);
      if (!fresh) {
        throw new AppError("License session is no longer valid", "LICENSE_SESSION_INVALID", 401);
      }

      if (fresh.license.creditsRemaining <= 0) {
        throw new AppError("This license has no credits remaining", "NO_CREDITS", 402, {
          creditsRemaining: 0,
        });
      }

      const ai = await createChatCompletion({
        messages: body.messages,
        temperature: body.temperature,
        maxTokens,
      });

      const cost = computeCreditCost(ai.usage, maxTokens);
      const consumed = consumeCredits({
        licenseId: fresh.license.id,
        deviceId: fresh.device.id,
        sessionId: fresh.session.id,
        kind: "ai_completion",
        credits: cost,
        tokensIn: ai.usage.promptTokens,
        tokensOut: ai.usage.completionTokens,
        model: ai.model,
        metadata: { messages: body.messages.length, maxTokens },
        ip: request.ip,
      });

      return {
        content: ai.content,
        model: ai.model,
        usage: ai.usage,
        maxTokens,
        creditsUsed: consumed.creditsUsed,
        creditsRemaining: consumed.creditsRemaining,
      };
    });

    return reply.send(result);
  });
}
