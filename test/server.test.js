import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostgate-test-"));
const dbPath = path.join(tmpDir, "test.db");

process.env.NODE_ENV = "test";
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = dbPath;
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASSWORD = "TestAdmin!2026";
process.env.ADMIN_NAME = "Test Admin";
process.env.HWID_PEPPER = "test-pepper-7d67db294736411fab4adf8d1898c585";
process.env.SESSION_HOURS = "24";
process.env.ADMIN_SESSION_HOURS = "12";
process.env.LOG_LEVEL = "silent";
process.env.AI_TIMEOUT_MS = "5000";
process.env.AI_CREDITS_PER_REQUEST = "1";
process.env.AI_TOKENS_PER_CREDIT = "1000";

const mockAi = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        model: "test-model",
        choices: [
          {
            message: {
              content: 'function reverse(s) { return [...s].reverse().join(""); }',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  });
});

await new Promise((resolve) => mockAi.listen(0, "127.0.0.1", resolve));
const mockPort = mockAi.address().port;

process.env.AI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
process.env.AI_API_KEY = "test-ai-key";
process.env.AI_MODEL = "test-model";

const { buildApp } = await import("../src/app.js");
const { ensureAdmin } = await import("../src/lib/auth.js");
const { closeDb } = await import("../src/db.js");

const app = await buildApp();
await ensureAdmin();
await app.listen({ port: 0, host: "127.0.0.1" });

const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
let adminToken = "";
let licenseId = "";
let licenseKey = "";
let sessionToken = "";
let sessionToken2 = "";

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data, headers: response.headers };
}

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}

function licenseHeaders() {
  return { Authorization: `Bearer ${sessionToken}` };
}

test.after(async () => {
  await app.close();
  await new Promise((resolve) => mockAi.close(resolve));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("health endpoint reports the server state", async () => {
  const response = await request("/v1/health");
  assert.equal(response.status, 200);
  assert.equal(response.data.status, "ok");
  assert.equal(response.data.aiConfigured, true);
});

test("admin login rejects invalid credentials", async () => {
  const response = await request("/v1/admin/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@test.local", password: "WrongPassword!2026" }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.data.error.code, "INVALID_CREDENTIALS");
});

test("admin login succeeds with valid credentials", async () => {
  const response = await request("/v1/admin/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@test.local", password: "TestAdmin!2026" }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.data.token);
  assert.equal(response.data.admin.email, "admin@test.local");
  adminToken = response.data.token;
});

test("admin routes reject missing auth", async () => {
  const response = await request("/v1/admin/licenses");
  assert.equal(response.status, 401);
  assert.equal(response.data.error.code, "ADMIN_UNAUTHORIZED");
});

test("admin can create a license and the full key is returned once", async () => {
  const response = await request("/v1/admin/licenses", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      customerName: "Test Customer",
      customerEmail: "customer@example.com",
      product: "GhostGate Client",
      plan: "pro",
      maxDevices: 2,
      maxTokensPerRequest: 4096,
      rateLimitPerMinute: 20,
      credits: 100,
      expiresInDays: 30,
      notes: "Created by test",
    }),
  });

  assert.equal(response.status, 201);
  assert.ok(response.data.licenseKey.startsWith("GG-"));
  assert.equal(response.data.license.creditsTotal, 100);
  assert.equal(response.data.license.maxDevices, 2);
  assert.equal(response.data.license.keyMasked.includes("••••"), true);
  licenseId = response.data.license.id;
  licenseKey = response.data.licenseKey;
});

test("license activation binds the first device", async () => {
  const response = await request("/v1/licenses/activate", {
    method: "POST",
    body: JSON.stringify({
      licenseKey,
      hwid: "test-hwid-0001",
      deviceName: "Test PC",
    }),
  });

  assert.equal(response.status, 201);
  assert.ok(response.data.sessionToken);
  assert.equal(response.data.license.creditsRemaining, 100);
  assert.equal(response.data.device.hwidDisplay.length > 0, true);
  sessionToken = response.data.sessionToken;
});

test("license activation accepts a normalized lowercase key", async () => {
  const normalized = licenseKey.toLowerCase().replace(/-/g, "");
  const response = await request("/v1/licenses/activate", {
    method: "POST",
    body: JSON.stringify({
      licenseKey: normalized,
      hwid: "test-hwid-0002",
      deviceName: "Second PC",
    }),
  });

  assert.equal(response.status, 201);
  assert.ok(response.data.sessionToken);
  sessionToken2 = response.data.sessionToken;
});

test("license activation enforces the device limit", async () => {
  const response = await request("/v1/licenses/activate", {
    method: "POST",
    body: JSON.stringify({
      licenseKey,
      hwid: "test-hwid-0003",
      deviceName: "Third PC",
    }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.data.error.code, "DEVICE_LIMIT_REACHED");
});

test("invalid license keys are rejected", async () => {
  const response = await request("/v1/licenses/activate", {
    method: "POST",
    body: JSON.stringify({ licenseKey: "GG-AAAA-AAAA-AAAA-AAAA", hwid: "test-hwid-0004" }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.data.error.code, "INVALID_LICENSE");
});

test("license session can query status and heartbeat", async () => {
  const status = await request("/v1/license", { headers: licenseHeaders() });
  assert.equal(status.status, 200);
  assert.equal(status.data.license.id, licenseId);
  assert.equal(status.data.license.creditsRemaining, 100);

  const heartbeat = await request("/v1/license/heartbeat", {
    method: "POST",
    headers: licenseHeaders(),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.data.license.creditsRemaining, 100);
});

test("AI completion uses a credit and returns content", async () => {
  const response = await request("/v1/ai/completions", {
    method: "POST",
    headers: licenseHeaders(),
    body: JSON.stringify({
      messages: [{ role: "user", content: "Reverse a string in JavaScript." }],
      maxTokens: 300,
    }),
  });

  assert.equal(response.status, 200);
  assert.ok(response.data.content.includes("reverse"));
  assert.ok(response.data.creditsUsed >= 1);
  assert.equal(response.data.creditsRemaining < 100, true);
});

test("client usage endpoint deducts credits", async () => {
  const response = await request("/v1/usage", {
    method: "POST",
    headers: licenseHeaders(),
    body: JSON.stringify({ kind: "test_usage", credits: 2, tokensIn: 5, tokensOut: 7 }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.creditsUsed, 2);
  assert.ok(response.data.creditsRemaining >= 0);
});

test("license usage endpoint returns recorded events", async () => {
  const response = await request("/v1/license/usage?limit=10", {
    headers: licenseHeaders(),
  });
  assert.equal(response.status, 200);
  assert.ok(response.data.usage.length >= 2);
});

test("admin can add credits and update limits", async () => {
  const credits = await request(`/v1/admin/licenses/${licenseId}/credits`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ amount: 50, reason: "Test top-up" }),
  });
  assert.equal(credits.status, 200);
  assert.equal(credits.data.license.creditsTotal, 150);

  const update = await request(`/v1/admin/licenses/${licenseId}`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ maxTokensPerRequest: 2048, rateLimitPerMinute: 30 }),
  });
  assert.equal(update.status, 200);
  assert.equal(update.data.license.maxTokensPerRequest, 2048);
  assert.equal(update.data.license.rateLimitPerMinute, 30);
});

test("suspending a license invalidates existing sessions", async () => {
  const suspend = await request(`/v1/admin/licenses/${licenseId}/status`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ status: "suspended" }),
  });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.data.license.status, "suspended");

  const status = await request("/v1/license", { headers: licenseHeaders() });
  assert.equal(status.status, 401);
});

test("reactivating a license requires a new session", async () => {
  const activate = await request(`/v1/admin/licenses/${licenseId}/status`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(activate.status, 200);

  const response = await request("/v1/licenses/activate", {
    method: "POST",
    body: JSON.stringify({ licenseKey, hwid: "test-hwid-0001", deviceName: "Test PC" }),
  });
  assert.equal(response.status, 201);
  sessionToken = response.data.sessionToken;
});

test("unbinding a device frees a seat", async () => {
  const detail = await request(`/v1/admin/licenses/${licenseId}`, {
    headers: adminHeaders(),
  });
  assert.equal(detail.status, 200);
  const device = detail.data.devices.find((item) => item.hwidDisplay && !item.revokedAt);
  assert.ok(device);

  const unbind = await request(
    `/v1/admin/licenses/${licenseId}/devices/${device.id}`,
    { method: "DELETE", headers: adminHeaders() },
  );
  assert.equal(unbind.status, 200);

  const response = await request("/v1/licenses/activate", {
    method: "POST",
    body: JSON.stringify({ licenseKey, hwid: "test-hwid-0003", deviceName: "Third PC" }),
  });
  assert.equal(response.status, 201);
});

test("revoking a license blocks activation", async () => {
  const revoke = await request(`/v1/admin/licenses/${licenseId}/status`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ status: "revoked" }),
  });
  assert.equal(revoke.status, 200);

  const response = await request("/v1/licenses/activate", {
    method: "POST",
    body: JSON.stringify({ licenseKey, hwid: "test-hwid-0004", deviceName: "Fourth PC" }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.data.error.code, "LICENSE_REVOKED");
});

test("audit log records privileged actions", async () => {
  const response = await request("/v1/admin/audit-logs?limit=100", {
    headers: adminHeaders(),
  });
  assert.equal(response.status, 200);
  assert.ok(response.data.logs.length > 0);
  assert.ok(
    response.data.logs.some((log) => log.action === "LICENSE_CREATED"),
  );
});

test("stats endpoint returns aggregate data", async () => {
  const response = await request("/v1/admin/stats", { headers: adminHeaders() });
  assert.equal(response.status, 200);
  assert.equal(response.data.totalLicenses >= 1, true);
  assert.ok(Array.isArray(response.data.usageByDay));
  assert.equal(response.data.usageByDay.length, 14);
});

test("CSV export returns license rows", async () => {
  const response = await fetch(`${baseUrl}/v1/admin/export`, {
    headers: adminHeaders(),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/csv/);
  const csv = await response.text();
  assert.match(csv, /customer_name/);
  assert.match(csv, /Test Customer/);
});

test("settings endpoint does not expose the AI key", async () => {
  const response = await request("/v1/admin/settings", { headers: adminHeaders() });
  assert.equal(response.status, 200);
  assert.equal(response.data.ai.configured, true);
  assert.equal(response.data.ai.apiKey, undefined);
  assert.equal(JSON.stringify(response.data).includes("test-ai-key"), false);
});

test("dashboard HTML is served", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /GhostGate/);
});

test("unknown API routes return JSON 404", async () => {
  const response = await request("/v1/does-not-exist");
  assert.equal(response.status, 404);
  assert.equal(response.data.error.code, "NOT_FOUND");
});

test("admin can change the password and old sessions stop working", async () => {
  const change = await request("/v1/admin/password", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      currentPassword: "TestAdmin!2026",
      newPassword: "NewTestAdmin!2026",
    }),
  });
  assert.equal(change.status, 200);

  const oldToken = await request("/v1/admin/me", { headers: adminHeaders() });
  assert.equal(oldToken.status, 401);

  const login = await request("/v1/admin/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@test.local", password: "NewTestAdmin!2026" }),
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
});
