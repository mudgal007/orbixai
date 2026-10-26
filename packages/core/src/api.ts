import { z } from "zod";
import { WorkflowDefinitionSchema } from "./workflow";

export const SignupSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  name: z.string().min(1).max(100),
});
export const LoginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(200),
});
export const CreateOrgSchema = z.object({ name: z.string().min(2).max(80) });
export const InviteMemberSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  role: z.enum(["admin", "operator", "approver", "viewer"]),
});
export const PlanMissionSchema = z.object({ objective: z.string().min(10).max(4000) });
export const SaveDraftSchema = z.object({ definition: WorkflowDefinitionSchema });
export const ImportWorkflowSchema = z.object({ definition: z.unknown() });
export const CreateRunSchema = z.object({
  mode: z.enum(["dry_run", "live"]),
  versionId: z.string().optional(),
});
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  comment: z.string().max(2000).optional(),
});
export const RequestChangesSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  comment: z.string().max(2000).optional(),
});
export const SandboxConnectionSchema = z.object({ provider: z.enum(["github", "slack"]) });
export const TokenConnectionSchema = z.object({
  provider: z.enum(["github", "slack"]),
  token: z.string().min(10).max(500),
  label: z.string().max(80).optional(),
});
export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(["admin", "operator", "viewer"]).default("operator"),
});
export const CreateWebhookSchema = z.object({
  url: z.string().url().max(2000),
  events: z.array(z.enum(["run.completed", "run.failed", "approval.requested"])).min(1),
});
export const CreateKnowledgeDocSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(500_000),
  collection: z.string().min(1).max(80).default("general"),
  sourceUrl: z.string().url().optional(),
});

export const UpdateScheduleSchema = z
  .object({ enabled: z.boolean().optional(), mode: z.enum(["dry_run", "live"]).optional() })
  .refine((v) => v.enabled !== undefined || v.mode !== undefined, "Provide enabled and/or mode");

export type SignupInput = z.infer<typeof SignupSchema>;
export type CreateRunInput = z.infer<typeof CreateRunSchema>;
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionSchema>;
