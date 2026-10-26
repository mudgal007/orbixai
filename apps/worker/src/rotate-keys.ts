import { rotateSecrets } from "@orbix/connectors";
import { getPrisma } from "@orbix/db";

/**
 * Re-encrypt stored secrets with the current key version.
 *   1. Add the new key:  ORBIX_ENCRYPTION_KEYS="2:<new base64>,1:<old base64>"
 *   2. pnpm keys:rotate --dry-run   (shows what would change)
 *   3. pnpm keys:rotate
 *   4. When the report shows nothing left on v1, remove v1 from ORBIX_ENCRYPTION_KEYS.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const prisma = getPrisma();
  const report = await rotateSecrets(prisma, { dryRun });
  console.log(JSON.stringify(report, null, 2));
  const old = Object.keys(report.versionsBefore).filter((v) => v !== `v${report.currentVersion}`);
  if (!dryRun) console.log(old.length ? `Re-encrypted secrets from ${old.join(", ")}; those keys can be removed after confirming services restarted with the new ring.` : "All secrets already use the current key.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
