import { execSync } from "node:child_process";
import { resolve } from "node:path";

/** Integration tests run against an isolated `<db>_test` database migrated from scratch. */
export default function setup() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL must be set (see .env.example)");
  const url = base.replace(/\/([^/?]+)(\?|$)/, "/$1_test$2");
  process.env.DATABASE_URL = url;
  execSync("npx prisma migrate deploy", { cwd: resolve(__dirname, "../../db"), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
