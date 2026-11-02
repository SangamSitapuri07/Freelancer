import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, "..", "..");
export const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, "data");
export const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dataDir, "ghostgate.db");
export const publicDir = path.join(rootDir, "public");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
