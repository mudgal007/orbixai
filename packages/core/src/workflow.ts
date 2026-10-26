import { z } from "zod";
import { AgentKeySchema } from "./agents";
import { RiskLevelSchema } from "./risk";

export const NODE_ID_RE = /^[a-z][a-z0-9_]{0,47}$/;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  backoffMs: z.number().int().min(100).max(60_000),
  maxBackoffMs: z.number().int().min(100).max(15 * 60_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const ApprovalConfigSchema = z.object({
  required: z.boolean(),
  approverRole: z.string().optional(),
  expiresInMinutes: z.number().int().min(1).max(7 * 24 * 60),
});

export const SuccessConditionSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["exists", "nonEmpty", "equals", "gte"]),
  value: z.unknown().optional(),
});
export type SuccessCondition = z.infer<typeof SuccessConditionSchema>;

export const WorkflowNodeSchema = z.object({
  id: z.string().regex(NODE_ID_RE, "lowercase letters, digits and underscores; must start with a letter"),
  title: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  agent: AgentKeySchema,
  action: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()),
  timeoutMs: z.number().int().min(1_000).max(15 * 60_000),
  retry: RetryPolicySchema,
  risk: RiskLevelSchema,
  approval: ApprovalConfigSchema,
  successCondition: SuccessConditionSchema.optional(),
  compensation: z.object({ action: z.string(), note: z.string() }).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("schedule"), cron: z.string().min(9).max(100), timezone: z.string().default("UTC") }),
  z.object({ type: z.literal("webhook"), event: z.string() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const WorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(120),
  objective: z.string().min(1).max(4000),
  trigger: TriggerSchema,
  nodes: z.array(WorkflowNodeSchema).min(1).max(50),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 1_000, maxBackoffMs: 30_000 };
export const NO_RETRY: RetryPolicy = { maxAttempts: 1, backoffMs: 1_000, maxBackoffMs: 1_000 };

/** JSON Schema for import/export, generated from the Zod source of truth. */
export function workflowJsonSchema(): unknown {
  return z.toJSONSchema(WorkflowDefinitionSchema, { target: "draft-2020-12" });
}
