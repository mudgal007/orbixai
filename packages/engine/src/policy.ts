import { ExecutionError, getAgent, getCapability, isExternalProvider, riskRank, type CapabilityDescriptor, type WorkflowNode } from "@orbix/core";
import { getConnector, type Connector } from "@orbix/connectors";
import type { PrismaClient } from "@orbix/db";

export interface PolicyDecision {
  capability: CapabilityDescriptor;
  connector?: Connector;
  connectionId?: string;
  connectionMode?: "sandbox" | "live";
  targetLabel: string;
}

/**
 * Deterministic, execution-time authorization. Runs immediately before every tool call; nothing the
 * model produced or a retrieved document contained can influence it.
 */
export async function authorizeToolCall(
  prisma: PrismaClient,
  input: { organizationId: string; runMode: "DRY_RUN" | "LIVE"; node: WorkflowNode },
): Promise<PolicyDecision> {
  const { node, organizationId } = input;
  const capability = getCapability(node.action);
  if (!capability || capability.availability !== "available") {
    throw new ExecutionError("permanent", `Action ${node.action} is not available`);
  }

  const agent = getAgent(node.agent);
  const orgAgent = await prisma.agentVersion.findFirst({
    where: { organizationId, agent: { key: node.agent } },
    orderBy: { version: "desc" },
  });
  // The org's agent version can only narrow the built-in allowlist, never widen it.
  const allowed = agent?.allowedCapabilities.filter((c) => !orgAgent || orgAgent.allowedCapabilities.includes(c)) ?? [];
  if (!allowed.includes(node.action)) {
    throw new ExecutionError("permission", `Agent ${node.agent} is not permitted to call ${node.action}`);
  }
  if (riskRank(node.risk) < riskRank(capability.risk)) {
    throw new ExecutionError("permission", `Node risk ${node.risk} is below capability risk ${capability.risk}`);
  }

  if (!isExternalProvider(capability.provider)) {
    return { capability, targetLabel: capability.provider === "ai" ? "ORBIX model gateway" : "Organization knowledge base" };
  }

  if (input.runMode === "DRY_RUN") {
    const connector = getConnector(capability.provider, "sandbox");
    if (!connector) throw new ExecutionError("permanent", `No sandbox connector for ${capability.provider}`);
    return { capability, connector, connectionMode: "sandbox", connectionId: "dry-run", targetLabel: `${capability.provider} sandbox (dry run)` };
  }

  const connections = await prisma.connection.findMany({
    where: { organizationId, provider: capability.provider, status: "ACTIVE" },
    orderBy: [{ mode: "desc" }, { createdAt: "desc" }], // LIVE before SANDBOX
  });
  const connection = connections[0];
  if (!connection) throw new ExecutionError("permission", `No active ${capability.provider} connection`);
  const mode = connection.mode === "LIVE" ? "live" : "sandbox";
  if (mode === "live") {
    const missing = capability.scopes.filter((s) => !connection.scopes.includes(s));
    if (missing.length) throw new ExecutionError("permission", `Connection is missing scopes: ${missing.join(", ")}`);
  }
  const connector = getConnector(capability.provider, mode);
  if (!connector) throw new ExecutionError("permanent", `No ${mode} connector for ${capability.provider}`);
  return { capability, connector, connectionId: connection.id, connectionMode: mode, targetLabel: `${connection.label} (${mode})` };
}
