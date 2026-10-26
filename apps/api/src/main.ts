import { createApp } from "./bootstrap";

async function main() {
  const app = await createApp();
  const port = Number(process.env.ORBIX_API_PORT ?? 4000);
  await app.listen(port);
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "info", svc: "api", msg: "api.started", port }) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
