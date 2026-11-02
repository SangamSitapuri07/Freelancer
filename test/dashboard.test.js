import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostgate-dashboard-"));
const dbPath = path.join(tmpDir, "dashboard.db");

process.env.NODE_ENV = "test";
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = dbPath;
process.env.ADMIN_EMAIL = "dashboard@test.local";
process.env.ADMIN_PASSWORD = "DashboardTest!2026";
process.env.ADMIN_NAME = "Dashboard Admin";
process.env.HWID_PEPPER = "dashboard-test-pepper-7d67db294736411fab4adf8d1898c585";
process.env.LOG_LEVEL = "silent";
process.env.AI_API_KEY = "";
process.env.AI_BASE_URL = "http://127.0.0.1:9/v1";
process.env.AI_MODEL = "test-model";

const { buildApp } = await import("../src/app.js");
const { ensureAdmin } = await import("../src/lib/auth.js");
const { closeDb } = await import("../src/db.js");

const app = await buildApp();
await ensureAdmin();
await app.listen({ port: 0, host: "127.0.0.1" });
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

const errors = [];
let dom;

async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for the dashboard condition");
}

test.after(async () => {
  if (dom) dom.window.close();
  await app.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dashboard signs in, renders the overview, and creates a license", async () => {
  dom = await JSDOM.fromURL(`${baseUrl}/`, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(input, baseUrl).toString(), init);
      window.isSecureContext = true;
      window.addEventListener("error", (event) => {
        errors.push(event.error || event.message);
      });
      window.addEventListener("unhandledrejection", (event) => {
        errors.push(event.reason);
      });
    },
  });

  const { window } = dom;
  const { document } = window;

  await waitFor(() => !document.getElementById("login-screen").hidden);
  assert.equal(document.getElementById("app-shell").hidden, true);

  document.getElementById("login-email").value = "dashboard@test.local";
  document.getElementById("login-password").value = "DashboardTest!2026";
  document.getElementById("login-form").dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );

  await waitFor(() => !document.getElementById("app-shell").hidden);
  await waitFor(() => document.getElementById("view-root").textContent.includes("Active licenses"));

  assert.equal(document.getElementById("page-title").textContent, "Overview");
  assert.equal(document.getElementById("admin-email").textContent, "dashboard@test.local");
  assert.equal(document.getElementById("admin-name").textContent, "Dashboard Admin");

  document.getElementById("new-license-button").click();
  await waitFor(() => !document.getElementById("modal-root").hidden);
  assert.match(document.getElementById("modal-root").textContent, /New license/);

  const form = document.querySelector('[data-form="create-license"]');
  assert.ok(form);

  form.querySelector('input[name="customerName"]').value = "Dashboard Test";
  form.querySelector('input[name="customerEmail"]').value = "dash@example.com";
  form.querySelector('input[name="credits"]').value = "50";
  form.querySelector('input[name="maxDevices"]').value = "2";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => document.getElementById("modal-root").textContent.includes("License created"));
  assert.match(
    document.getElementById("modal-root").textContent,
    /GG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/,
  );

  const closeButton = document.querySelector('[data-action="close-modal"]');
  assert.ok(closeButton);
  closeButton.click();
  await waitFor(() => document.getElementById("modal-root").hidden);

  document.querySelector('[data-view="licenses"]').click();
  await waitFor(() => document.getElementById("view-root").textContent.includes("Dashboard Test"));
  assert.equal(document.getElementById("page-title").textContent, "Licenses");
  assert.match(document.getElementById("view-root").textContent, /Dashboard Test/);

  assert.deepEqual(errors, []);
});
