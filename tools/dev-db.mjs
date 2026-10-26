// Local Postgres without Docker: runs a private PostgreSQL 17 cluster in ./.data/pg on port 5433.
// Usage: pnpm db:up   (keeps running; Ctrl+C to stop)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const databaseDir = resolve(".data/pg");
const pg = new EmbeddedPostgres({ databaseDir, user: "orbix", password: "orbix", port: 5433, persistent: true });

if (!existsSync(resolve(databaseDir, "PG_VERSION"))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("orbix");
} catch {
  /* already exists */
}
console.log("Postgres ready: postgresql://orbix:orbix@localhost:5433/orbix");
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
