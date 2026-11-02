import "dotenv/config";
import { buildApp } from "./app.js";
import { closeDb } from "./db.js";
import { ensureAdmin } from "./lib/auth.js";

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const host = process.env.HOST || "0.0.0.0";
const app = await buildApp();

await ensureAdmin();
await app.listen({ port, host });

app.log.info(`GhostGate is listening on http://${host}:${port}`);
app.log.info(`Admin dashboard: http://localhost:${port}`);
app.log.info(`Health check: http://localhost:${port}/v1/health`);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}; shutting down`);
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, "Error while closing the server");
  }
  closeDb();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
