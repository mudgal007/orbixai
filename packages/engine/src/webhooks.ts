import { decryptSecret, assertSafeOutboundUrl, signOutboundWebhook } from "@orbix/connectors";
import type { PrismaClient } from "@orbix/db";

/** Best-effort outbound delivery with HMAC signatures and SSRF protection. */
export async function deliverWebhooks(
  prisma: PrismaClient,
  organizationId: string,
  event: string,
  data: Record<string, unknown>,
  log?: (msg: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  const subs = await prisma.webhookSubscription.findMany({ where: { organizationId, active: true, events: { has: event } } });
  for (const sub of subs) {
    const body = JSON.stringify({ id: `${event}:${Date.now()}`, event, organizationId, createdAt: new Date().toISOString(), data });
    let status = 0;
    try {
      await assertSafeOutboundUrl(sub.url, { allowPrivate: process.env.ORBIX_ALLOW_PRIVATE_WEBHOOKS === "true" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(sub.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Orbix-Event": event, "X-Orbix-Signature": signOutboundWebhook(decryptSecret(sub.secretEncrypted), body) },
        body,
        signal: controller.signal,
        redirect: "manual",
      }).finally(() => clearTimeout(timer));
      status = res.status;
    } catch (e) {
      log?.("webhook.failed", { subscriptionId: sub.id, message: (e as Error).message });
    }
    await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { lastDeliveryAt: new Date(), lastStatus: status } });
  }
}
