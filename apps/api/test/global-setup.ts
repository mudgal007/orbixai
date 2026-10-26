import { execSync } from "node:child_process";
import { resolve } from "node:path";

/** Integration tests run against an isolated `<db>_test` database migrated from scratch. */
export default function setup() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL must be set (see .env.example)");
  const url = base.replace(/\/([^/?]+)(\?|$)/, "/$1_test$2");
  process.env.DATABASE_URL = url;
  const cwd = resolve(__dirname, "../../../packages/db");
  execSync("npx prisma migrate deploy", { cwd, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  // Run tests with a non-UTC session TimeZone so timestamp handling bugs surface even on UTC CI servers.
  const db = new URL(url).pathname.slice(1);
  execSync("npx prisma db execute --stdin --schema prisma/schema.prisma", { cwd, input: `ALTER DATABASE "${db}" SET timezone TO 'Asia/Kolkata';`, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
