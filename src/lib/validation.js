import { z } from "zod";
import { AppError } from "./errors.js";

const email = z.string().trim().toLowerCase().email().max(254);
const optionalEmail = email.or(z.literal("")).optional();

export const adminLoginSchema = z.object({
  email,
  password: z.string().min(8).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
});

export const createLicenseSchema = z.object({
  customerName: z.string().trim().min(1).max(120),
  customerEmail: optionalEmail,
  product: z.string().trim().min(1).max(80).default("GhostGate Client"),
  plan: z.enum(["starter", "standard", "pro", "enterprise"]).default("standard"),
  maxDevices: z.number().int().min(1).max(100).default(1),
  maxTokensPerRequest: z.number().int().min(256).max(32768).default(4096),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(20),
  credits: z.number().int().min(1).max(1000000).default(100),
  expiresInDays: z.number().int().min(1).max(3650).default(30),
  notes: z.string().trim().max(2000).optional(),
});

export const updateLicenseSchema = z
  .object({
    customerName: z.string().trim().min(1).max(120).optional(),
    customerEmail: optionalEmail,
    product: z.string().trim().min(1).max(80).optional(),
    plan: z.enum(["starter", "standard", "pro", "enterprise"]).optional(),
    status: z.enum(["active", "suspended", "revoked"]).optional(),
    maxDevices: z.number().int().min(1).max(100).optional(),
    maxTokensPerRequest: z.number().int().min(256).max(32768).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
    creditsTotal: z.number().int().min(0).max(1000000).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const addCreditsSchema = z.object({
  amount: z.number().int().min(1).max(1000000),
  reason: z.string().trim().max(200).optional(),
});

export const licenseStatusSchema = z.object({
  status: z.enum(["active", "suspended", "revoked"]),
});

export const activateSchema = z.object({
  licenseKey: z.string().trim().min(8).max(100),
  hwid: z.string().trim().min(8).max(512),
  deviceName: z.string().trim().max(120).optional(),
});

export const releaseDeviceSchema = z.object({
  deviceId: z.string().trim().min(1).max(100),
});

export const usageSchema = z.object({
  kind: z.string().trim().min(1).max(60).default("client_usage"),
  credits: z.number().int().min(1).max(1000),
  tokensIn: z.number().int().min(0).max(1000000).optional().default(0),
  tokensOut: z.number().int().min(0).max(1000000).optional().default(0),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const aiCompletionSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(20000),
      }),
    )
    .min(1)
    .max(20),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32768).optional(),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  search: z.string().trim().max(120).optional(),
});

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError("Validation failed", "VALIDATION_ERROR", 400, result.error.flatten());
  }
  return result.data;
}
