import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CAPABILITIES, InviteMemberSchema } from "@orbix/core";
import { appendAudit, type PrismaClient } from "@orbix/db";
import { Auth, RequirePermission, type AuthContext } from "../common/context";
import { PRISMA } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

@ApiTags("organization")
@Controller("orgs/:orgId")
export class OrgController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  @RequirePermission("workflow:read")
  async get(@Param("orgId") orgId: string, @Auth() auth: AuthContext) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { subscription: true } });
    return { organization: org, role: auth.roleKey, permissions: auth.permissions };
  }

  @Get("members")
  @RequirePermission("member:read")
  async members(@Param("orgId") orgId: string) {
    const rows = await this.prisma.membership.findMany({ where: { organizationId: orgId }, include: { user: true, role: true }, orderBy: { createdAt: "asc" } });
    const roles = await this.prisma.role.findMany({ where: { organizationId: orgId } });
    return {
      members: rows.map((m) => ({ id: m.id, user: { id: m.user.id, name: m.user.name, email: m.user.email }, role: m.role.key, joinedAt: m.createdAt })),
      roles: roles.map((r) => ({ key: r.key, name: r.name, permissions: r.permissions })),
    };
  }

  /** Adds an existing ORBIX user. Email invitations are roadmap (no outbound email in the MVP). */
  @Post("members")
  @RequirePermission("member:manage")
  async addMember(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(InviteMemberSchema)) body: { email: string; role: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (!user) throw new NotFoundException({ code: "user_not_found", message: "No ORBIX account uses that email yet. Ask them to sign up first." });
    const role = await this.prisma.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: orgId, key: body.role } } });
    const exists = await this.prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId: user.id } } });
    if (exists) throw new ConflictException("Already a member");
    const m = await this.prisma.membership.create({ data: { organizationId: orgId, userId: user.id, roleId: role.id } });
    await appendAudit(this.prisma, { organizationId: orgId, actorType: auth.kind, actorId: auth.userId ?? auth.apiKeyId, action: "member.added", targetType: "user", targetId: user.id, data: { role: body.role } });
    return { membership: m };
  }

  @Delete("members/:membershipId")
  @HttpCode(204)
  @RequirePermission("member:manage")
  async removeMember(@Param("orgId") orgId: string, @Param("membershipId") id: string, @Auth() auth: AuthContext) {
    const m = await this.prisma.membership.findFirst({ where: { id, organizationId: orgId }, include: { role: true } });
    if (!m) throw new NotFoundException();
    if (m.role.key === "owner") {
      const owners = await this.prisma.membership.count({ where: { organizationId: orgId, role: { key: "owner" } } });
      if (owners <= 1) throw new ConflictException("An organization needs at least one owner");
    }
    await this.prisma.membership.delete({ where: { id } });
    await appendAudit(this.prisma, { organizationId: orgId, actorType: auth.kind, actorId: auth.userId ?? auth.apiKeyId, action: "member.removed", targetType: "user", targetId: m.userId });
  }

  @Get("agents")
  @RequirePermission("workflow:read")
  async agents(@Param("orgId") orgId: string) {
    const agents = await this.prisma.agent.findMany({ where: { organizationId: orgId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } }, orderBy: { name: "asc" } });
    const usage = await this.prisma.taskRun.groupBy({ by: ["agentKey", "status"], where: { organizationId: orgId }, _count: true });
    return {
      agents: agents.map((a) => {
        const v = a.versions[0];
        const stats = usage.filter((u) => u.agentKey === a.key);
        return {
          key: a.key,
          name: a.name,
          description: a.description,
          version: v?.version ?? 1,
          tools: (v?.allowedCapabilities ?? []).map((id) => {
            const c = CAPABILITIES.find((x) => x.id === id);
            return { id, title: c?.title ?? id, risk: c?.risk, availability: c?.availability ?? "unknown" };
          }),
          stats: {
            tasks: stats.reduce((n, s) => n + s._count, 0),
            succeeded: stats.filter((s) => s.status === "SUCCEEDED").reduce((n, s) => n + s._count, 0),
          },
        };
      }),
    };
  }
}
