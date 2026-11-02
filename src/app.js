import crypto from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { AppError, errorResponse } from "./lib/errors.js";
import { publicDir } from "./lib/paths.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerLicenseRoutes } from "./routes/licenses.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
  });

  const configuredOrigins = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin:
      configuredOrigins.length === 1 && configuredOrigins[0] === "*"
        ? true
        : configuredOrigins.length
          ? configuredOrigins
          : false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    allowList: (request) =>
      request.url === "/" ||
      request.url === "/v1/health" ||
      request.url.startsWith("/styles.css") ||
      request.url.startsWith("/app.js") ||
      request.url.startsWith("/favicon"),
  });

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    index: "index.html",
    cacheControl: false,
    etag: true,
  });

  await registerAdminRoutes(app);
  await registerLicenseRoutes(app);
  await registerAiRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send(errorResponse(error));
    }

    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.message,
          details: error.validation,
        },
      });
    }

    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code || "REQUEST_ERROR",
          message: error.message,
        },
      });
    }

    request.log.error({ err: error, requestId: request.id }, "Unhandled error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong on the server",
      },
    });
  });

  return app;
}
