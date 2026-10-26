import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Put, Query, UnprocessableEntityException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  ImportWorkflowSchema,
  PlanMissionSchema,
  SaveDraftSchema,
  normalizeDefinition,
  simulatePlan,
  validateWorkflow,
  workflowJsonSchema,
  type WorkflowDefinition,
} from "@orbix/core";
import { hashPayload } from "@orbix/core/node";
import { appendAudit, type Prisma, type PrismaClient } from "@orbix/db";
import { layoutNodes, planWorkflow, type ModelClient, type Scheduler } from "@orbix/engine";
import { Auth, Public, RequirePermission, actorOf, type AuthContext } from "../common/context";
import { MODEL, PRISMA, SCHEDULER } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

const json = (v: unknown) => v as Prisma.InputJsonValue;

@ApiTags("workflows")
@Controller()
export class WorkflowsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MODEL) private readonly model: ModelClient,
    @Inject(SCHEDULER) private readonly scheduler: Scheduler,
  ) {}

  private actor(auth: AuthContext) {
    return { actorType: auth.kind, actorId: auth.userId ?? auth.apiKeyId } as const;
  }

  private async getWorkflow(orgId: string, id: string) {
    const wf = await this.prisma.workflow.findFirst({ where: { id, organizationId: orgId, archived: false } });
    if (!wf) throw new NotFoundException("Workflow not found");
    return wf;
  }

  @Public()
  @Get("schemas/workflow.json")
  schema() {
    return workflowJsonSchema();
  }

  /** Natural-language objective → mission + editable draft workflow. */
  @Post("orgs/:orgId/missions/plan")
  @RequirePermission("workflow:write")
  async plan(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(PlanMissionSchema)) body: { objective: string }) {
    const result = await planWorkflow(body.objective, this.model);
    const { mission, workflow } = await this.prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.create({
        data: { organizationId: orgId, name: result.definition.name, description: body.objective, draft: json(result.definition), createdById: auth.userId },
      });
      const mission = await tx.mission.create({
        data: { organizationId: orgId, objective: body.objective, workflowId: workflow.id, planner: result.planner, plannerNotes: json(result.notes), createdById: auth.userId },
      });
      return { mission, workflow };
    });
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "mission.planned", targetType: "workflow", targetId: workflow.id, data: { planner: result.planner, nodes: result.definition.nodes.length } });
    return { mission, workflow, planner: result.planner, notes: result.notes, issues: result.issues };
  }

  @Get("orgs/:orgId/missions")
  @RequirePermission("workflow:read")
  async missions(@Param("orgId") orgId: string) {
    const missions = await this.prisma.mission.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { workflow: { select: { id: true, name: true, latestVersionId: true } }, runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, outcome: true, createdAt: true } } },
    });
    return { missions };
  }

  @Get("orgs/:orgId/workflows")
  @RequirePermission("workflow:read")
  async list(@Param("orgId") orgId: string) {
    const workflows = await this.prisma.workflow.findMany({
      where: { organizationId: orgId, archived: false },
      orderBy: { createdAt: "desc" },
      include: {
        versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, createdAt: true } },
        schedule: { select: { enabled: true, cron: true, timezone: true, mode: true, nextRunAt: true } },
        _count: { select: { runs: true } },
      },
    });
    return { workflows };
  }

  @Get("orgs/:orgId/workflows/:id")
  @RequirePermission("workflow:read")
  async get(@Param("orgId") orgId: string, @Param("id") id: string) {
    const wf = await this.getWorkflow(orgId, id);
    const versions = await this.prisma.workflowVersion.findMany({
      where: { workflowId: wf.id, organizationId: orgId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, definitionHash: true, createdAt: true, publishedById: true },
    });
    const mission = await this.prisma.mission.findFirst({ where: { workflowId: wf.id, organizationId: orgId }, orderBy: { createdAt: "desc" } });
    const validation = validateWorkflow(wf.draft);
    const latest = versions[0];
    return {
      workflow: wf,
      versions,
      mission,
      validation: { valid: validation.valid, issues: validation.issues },
      draftMatchesLatest: latest ? latest.definitionHash === hashPayload(wf.draft) : false,
    };
  }

  @Put("orgs/:orgId/workflows/:id/draft")
  @RequirePermission("workflow:write")
  async saveDraft(@Param("orgId") orgId: string, @Param("id") id: string, @Body(new ZodPipe(SaveDraftSchema)) body: { definition: WorkflowDefinition }) {
    await this.getWorkflow(orgId, id);
    const { definition, notes } = normalizeDefinition(body.definition);
    const validation = validateWorkflow(definition);
    const wf = await this.prisma.workflow.update({ where: { id }, data: { draft: json(definition), name: definition.name, draftUpdatedAt: new Date() } });
    return { workflow: wf, policyNotes: notes, validation: { valid: validation.valid, issues: validation.issues } };
  }

  @Post("orgs/:orgId/workflows/:id/validate")
  @RequirePermission("workflow:read")
  async validate(@Param("orgId") orgId: string, @Param("id") id: string) {
    const wf = await this.getWorkflow(orgId, id);
    const r = validateWorkflow(wf.draft);
    return { valid: r.valid, issues: r.issues };
  }

  /** Publishes the draft as an immutable, versioned definition (with normalised node/edge rows). */
  @Post("orgs/:orgId/workflows/:id/publish")
  @RequirePermission("workflow:write")
  async publish(@Param("orgId") orgId: string, @Param("id") id: string, @Auth() auth: AuthContext) {
    const wf = await this.getWorkflow(orgId, id);
    const { definition } = normalizeDefinition(wf.draft as unknown as WorkflowDefinition);
    const v = validateWorkflow(definition);
    if (!v.valid) throw new UnprocessableEntityException({ code: "invalid_workflow", message: "Fix validation errors before publishing", details: v.issues });
    const hash = hashPayload(definition);
    const latest = await this.prisma.workflowVersion.findFirst({ where: { workflowId: id }, orderBy: { version: "desc" } });
    if (latest?.definitionHash === hash) return { version: latest, unchanged: true };

    const version = await this.prisma.$transaction(async (tx) => {
      const version = await tx.workflowVersion.create({
        data: { organizationId: orgId, workflowId: id, version: (latest?.version ?? 0) + 1, definition: json(definition), definitionHash: hash, publishedById: auth.userId },
      });
      await tx.workflowNode.createMany({
        data: definition.nodes.map((n) => ({
          organizationId: orgId,
          workflowVersionId: version.id,
          nodeKey: n.id,
          agentKey: n.agent,
          action: n.action,
          risk: n.risk,
          approvalRequired: n.approval.required,
          config: json(n),
        })),
      });
      const edges = definition.nodes.flatMap((n) => n.dependsOn.map((d) => ({ organizationId: orgId, workflowVersionId: version.id, fromKey: d, toKey: n.id })));
      if (edges.length) await tx.workflowEdge.createMany({ data: edges });
      await tx.workflow.update({ where: { id }, data: { latestVersionId: version.id, draft: json(definition) } });
      return version;
    });
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "workflow.published", targetType: "workflow", targetId: id, data: { version: version.version, hash } });
    const schedule = await this.scheduler.syncFromVersion({ organizationId: orgId, workflowId: id, workflowVersionId: version.id, trigger: definition.trigger, actor: actorOf(auth) });
    return { version, unchanged: false, schedule };
  }

  /** Plan Preview: validation, execution path, costs, side effects. Performs no external calls. */
  @Post("orgs/:orgId/workflows/:id/simulate")
  @RequirePermission("workflow:read")
  async simulate(@Param("orgId") orgId: string, @Param("id") id: string, @Query("versionId") versionId?: string) {
    const wf = await this.getWorkflow(orgId, id);
    let def = wf.draft as unknown as WorkflowDefinition;
    if (versionId) {
      const v = await this.prisma.workflowVersion.findFirst({ where: { id: versionId, workflowId: id, organizationId: orgId } });
      if (!v) throw new NotFoundException("Version not found");
      def = v.definition as unknown as WorkflowDefinition;
    }
    const connections = await this.prisma.connection.findMany({ where: { organizationId: orgId } });
    const report = simulatePlan(
      def,
      connections.map((c) => ({ provider: c.provider, mode: c.mode === "LIVE" ? "live" : "sandbox", scopes: c.scopes, status: c.status === "ACTIVE" ? "active" : c.status === "REVOKED" ? "revoked" : "error" })),
      this.model.name,
    );
    return { report, model: { name: this.model.name, heuristic: this.model.heuristic } };
  }

  @Get("orgs/:orgId/workflows/:id/export")
  @RequirePermission("workflow:read")
  async export(@Param("orgId") orgId: string, @Param("id") id: string, @Query("versionId") versionId?: string) {
    const wf = await this.getWorkflow(orgId, id);
    if (!versionId) return { $schema: "/v1/schemas/workflow.json", definition: wf.draft };
    const v = await this.prisma.workflowVersion.findFirst({ where: { id: versionId, workflowId: id, organizationId: orgId } });
    if (!v) throw new NotFoundException("Version not found");
    return { $schema: "/v1/schemas/workflow.json", version: v.version, definition: v.definition };
  }

  @Post("orgs/:orgId/workflows/import")
  @RequirePermission("workflow:write")
  async import(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(ImportWorkflowSchema)) body: { definition: unknown }) {
    const parsed = validateWorkflow(body.definition);
    if (!parsed.definition) throw new UnprocessableEntityException({ code: "invalid_workflow", message: "Definition does not match the workflow schema", details: parsed.issues });
    const { definition } = normalizeDefinition(layoutNodes(parsed.definition));
    const wf = await this.prisma.workflow.create({ data: { organizationId: orgId, name: definition.name, description: definition.objective, draft: json(definition), createdById: auth.userId } });
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "workflow.imported", targetType: "workflow", targetId: wf.id });
    return { workflow: wf, validation: validateWorkflow(definition) };
  }
}
