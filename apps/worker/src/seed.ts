import { hashPassword } from "@orbix/core/node";
import { seedGithubSandbox } from "@orbix/connectors";
import { bootstrapOrganization, getPrisma, syncIntegrationCatalog } from "@orbix/db";

/**
 * Seeds a demo environment: one user, one org, sandbox GitHub + Slack connections and sandbox issues.
 * No runs or metrics are fabricated — the dashboard stays empty until you execute a mission.
 */
const DEMO_EMAIL = "demo@orbix.dev";
const DEMO_PASSWORD = "orbix-demo-password";

async function main() {
  const prisma = getPrisma();
  await syncIntegrationCatalog(prisma);
  let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (user) {
    console.log(`Demo user already exists: ${DEMO_EMAIL}`);
  } else {
    user = await prisma.user.create({ data: { email: DEMO_EMAIL, name: "Demo Operator", passwordHash: await hashPassword(DEMO_PASSWORD) } });
    const org = await bootstrapOrganization(prisma, { name: "Acme Robotics", ownerUserId: user.id });
    for (const provider of ["github", "slack"]) {
      await prisma.connection.create({
        data: { organizationId: org.id, provider, label: `${provider === "github" ? "GitHub" : "Slack"} sandbox`, mode: "SANDBOX", scopes: [], createdById: user.id },
      });
    }
    await seedGithubSandbox(prisma, org.id);
    console.log(`Seeded org "${org.name}" with sandbox GitHub + Slack.`);
    console.log(`Sign in with ${DEMO_EMAIL} / ${DEMO_PASSWORD} (local demo credentials).`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
