import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DUMMY_SALT = "00".repeat(16);
const DUMMY_HASH = crypto.scryptSync("ghostgate-dummy-password", DUMMY_SALT, 64).toString("hex");

let cachedPepper;

export function nowIso() {
  return new Date().toISOString();
}

export function addHoursIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function addDaysIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function isPast(iso) {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

export function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashToken(token) {
  return sha256(token);
}

export function generateLicenseKey() {
  const bytes = crypto.randomBytes(16);
  let body = "";
  for (let i = 0; i < 16; i += 1) {
    body += LICENSE_ALPHABET[bytes[i] % LICENSE_ALPHABET.length];
  }
  return `GG-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

export function normalizeLicenseKey(input) {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned.startsWith("GG")) return null;
  const body = cleaned.slice(2);
  if (body.length !== 16) return null;
  return `GG-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

export function maskLicenseKey(key) {
  const parts = String(key).split("-");
  if (parts.length !== 5) return "GG-••••-••••-••••-••••";
  return `${parts[0]}-••••-••••-••••-${parts[4]}`;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    hash: crypto.scryptSync(password, salt, 64).toString("hex"),
    salt,
  };
}

export function verifyPassword(password, expectedHash, salt) {
  const expected = Buffer.from(expectedHash, "hex");
  const candidate = crypto.scryptSync(password, salt, 64);
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(expected, candidate);
}

export function verifyPasswordConstantTime(password) {
  const candidate = crypto.scryptSync(password, DUMMY_SALT, 64);
  const expected = Buffer.from(DUMMY_HASH, "hex");
  return crypto.timingSafeEqual(candidate, expected);
}

export function getPepper() {
  if (cachedPepper) return cachedPepper;
  const fromEnv = process.env.HWID_PEPPER?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      console.warn(
        "[ghostgate] HWID_PEPPER is shorter than 32 characters. Use a long random secret in production.",
      );
    }
    cachedPepper = fromEnv;
    return cachedPepper;
  }
  const pepperPath = path.join(dataDir, "pepper.key");
  if (fs.existsSync(pepperPath)) {
    cachedPepper = fs.readFileSync(pepperPath, "utf8").trim();
  } else {
    cachedPepper = crypto.randomBytes(48).toString("base64url");
    fs.writeFileSync(pepperPath, cachedPepper, { mode: 0o600 });
  }
  return cachedPepper;
}

export function hwidIsConfigured() {
  return Boolean(process.env.HWID_PEPPER?.trim() || fs.existsSync(path.join(dataDir, "pepper.key")));
}

export function hashHwid(hwid) {
  return crypto.createHmac("sha256", getPepper()).update(String(hwid).trim().toLowerCase()).digest("hex");
}

export function hwidDisplay(hwid) {
  const digest = sha256(String(hwid).trim().toLowerCase());
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}

export function getAiConfig() {
  return {
    baseUrl: (process.env.AI_BASE_URL?.trim() || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
    apiKey: process.env.AI_API_KEY?.trim() || "",
    model: process.env.AI_MODEL?.trim() || "openai/gpt-oss-120b",
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 90000,
    systemPrompt:
      process.env.AI_SYSTEM_PROMPT?.trim() ||
      "You are a helpful software engineering assistant. Provide concise, correct, and secure code. Explain trade-offs when useful. Do not assist with academic dishonesty, including completing graded exams, quizzes, or assessments. If a request appears to be an attempt to cheat on an assessment, decline and offer to help the user learn the underlying concepts instead.",
    creditsPerRequest: Math.max(1, Number(process.env.AI_CREDITS_PER_REQUEST) || 1),
    tokensPerCredit: Math.max(1, Number(process.env.AI_TOKENS_PER_CREDIT) || 1000),
  };
}

export function sessionHours() {
  return Math.max(1, Number(process.env.SESSION_HOURS) || 24);
}

export function adminSessionHours() {
  return Math.max(1, Number(process.env.ADMIN_SESSION_HOURS) || 12);
}

export function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
