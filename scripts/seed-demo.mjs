import "dotenv/config";
import { closeDb } from "../src/db.js";
import { ensureAdmin, findAdminByEmail } from "../src/lib/auth.js";
import { createLicense } from "../src/lib/licenses.js";

const email = process.env.ADMIN_EMAIL?.trim() || "admin@ghostgate.local";
const admin = ensureAdmin() || findAdminByEmail(email);

if (!admin) {
  console.error("No admin found. Set ADMIN_EMAIL and ADMIN_PASSWORD and try again.");
  process.exit(1);
}

const result = createLicense({
  admin: { id: admin.id, email: admin.email, ip: "cli" },
  customerName: "Demo Customer",
  customerEmail: "demo@example.com",
  product: "GhostGate Client",
  plan: "standard",
  maxDevices: 2,
  maxTokensPerRequest: 4096,
  rateLimitPerMinute: 20,
  credits: 100,
  expiresInDays: 30,
  notes: "Demo license created by scripts/seed-demo.mjs",
});

console.log("Demo license created.");
console.log(`License key: ${result.licenseKey}`);
console.log(`Customer:    ${result.license.customerName}`);
console.log(`Credits:     ${result.license.creditsTotal}`);
console.log(`Devices:     ${result.license.maxDevices}`);
console.log(`Expires:     ${result.license.expiresAt}`);
console.log("");
console.log("Activate it with the demo client:");
console.log(
  `  node scripts/demo-client.mjs --license "${result.licenseKey}" --base http://localhost:8080`,
);

closeDb();
process.exit(0);
