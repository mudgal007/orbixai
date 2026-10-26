import { hostname } from "node:os";
import { CredentialBroker } from "@orbix/connectors";
import { getPrisma, syncIntegrationCatalog } from "@orbix/db";
import { ExecutionEngine, createModelFromEnv } from "@orbix/engine";

/** Structured JSON logs (one object per line) for log shipping. */
const log = (msg: string, data: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "info", svc: "worker", msg, ...data }) + "\n");

async function main() {
  const prisma = getPrisma();
  const model = createModelFromEnv();
  const workerId = `${hostname()}:${process.pid}`;
  const engine = new ExecutionEngine({
    prisma,
    model,
    broker: new CredentialBroker(prisma),
    workerId,
    leaseMs: Number(process.env.ORBIX_TASK_LEASE_MS ?? 60_000),
    log,
  });
  await syncIntegrationCatalog(prisma);
  log("worker.started", { workerId, model: model.name, heuristic: model.heuristic });

  const concurrency = Number(process.env.ORBIX_WORKER_CONCURRENCY ?? 4);
  const pollMs = Number(process.env.ORBIX_WORKER_POLL_MS ?? 500);
  let stopping = false;
  let lastMaintenance = 0;

  const shutdown = (signal: string) => {
    log("worker.stopping", { signal });
    stopping = true;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!stopping) {
    try {
      if (Date.now() - lastMaintenance > 10_000) {
        const m = await engine.maintenance();
        if (m.recovered || m.expired || m.reconciled) log("worker.maintenance", m);
        lastMaintenance = Date.now();
      }
      const claimed = await engine.tick(concurrency);
      if (claimed === 0) await new Promise((r) => setTimeout(r, pollMs));
    } catch (e) {
      log("worker.error", { message: (e as Error).message });
      await new Promise((r) => setTimeout(r, pollMs * 4));
    }
  }
  await prisma.$disconnect();
  log("worker.stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
