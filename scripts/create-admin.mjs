import "dotenv/config";
import { createAdmin, findAdminByEmail } from "../src/lib/auth.js";
import { closeDb } from "../src/db.js";

const [email, password, displayName] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: node scripts/create-admin.mjs <email> <password> [display-name]");
  process.exit(1);
}

if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

if (findAdminByEmail(email)) {
  console.error(`An admin with ${email} already exists.`);
  process.exit(1);
}

const admin = createAdmin({
  email,
  password,
  displayName: displayName || "Administrator",
});

console.log(`Admin created: ${admin.email}`);
console.log(`Display name: ${admin.displayName}`);
closeDb();
process.exit(0);
