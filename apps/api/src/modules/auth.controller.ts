import { Body, ConflictException, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CreateOrgSchema, LoginSchema, SignupSchema } from "@orbix/core";
import { hashPassword, randomToken, sha256, verifyPassword } from "@orbix/core/node";
import { appendAudit, bootstrapOrganization, type PrismaClient } from "@orbix/db";
import type { Response } from "express";
import { SESSION_COOKIE } from "../common/auth.guard";
import { Auth, Public, type AuthContext, type OrbixRequest } from "../common/context";
import { PRISMA } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
/** Per-IP limit for signup/login (brute-force protection). */
const AUTH_LIMIT = { default: { limit: Number(process.env.ORBIX_AUTH_RATE_LIMIT_PER_MIN ?? 10), ttl: 60_000 } };
// Constant-time-ish defence against user enumeration: verify against a dummy hash when no user exists.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

@ApiTags("auth")
@Controller()
export class AuthController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private async startSession(res: Response, userId: string, userAgent?: string) {
    const token = randomToken(32);
    await this.prisma.session.create({
      data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS), userAgent: userAgent?.slice(0, 200) },
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post("auth/signup")
  async signup(@Body(new ZodPipe(SignupSchema)) body: { email: string; password: string; name: string }, @Req() req: OrbixRequest, @Res({ passthrough: true }) res: Response) {
    const exists = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new ConflictException({ code: "email_taken", message: "An account with this email already exists" });
    const user = await this.prisma.user.create({ data: { email: body.email, name: body.name, passwordHash: await hashPassword(body.password) } });
    await this.startSession(res, user.id, req.headers["user-agent"]);
    return { user: { id: user.id, email: user.email, name: user.name } };
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @HttpCode(200)
  @Post("auth/login")
  async login(@Body(new ZodPipe(LoginSchema)) body: { email: string; password: string }, @Req() req: OrbixRequest, @Res({ passthrough: true }) res: Response) {
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException({ code: "invalid_credentials", message: "Email or password is incorrect" });
    await this.startSession(res, user.id, req.headers["user-agent"]);
    return { user: { id: user.id, email: user.email, name: user.name } };
  }

  @HttpCode(204)
  @Post("auth/logout")
  async logout(@Req() req: OrbixRequest, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string>)[SESSION_COOKIE];
    if (token) await this.prisma.session.updateMany({ where: { tokenHash: sha256(token) }, data: { revokedAt: new Date() } });
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  @Get("me")
  async me(@Auth() auth: AuthContext) {
    if (auth.kind === "api_key") {
      const org = await this.prisma.organization.findUnique({ where: { id: auth.organizationId! } });
      return { kind: "api_key", organization: org, role: auth.roleKey };
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId! },
      include: { memberships: { include: { organization: true, role: true }, orderBy: { createdAt: "asc" } } },
    });
    return {
      kind: "user",
      user: { id: user.id, email: user.email, name: user.name },
      memberships: user.memberships.map((m) => ({ organization: { id: m.organization.id, name: m.organization.name, slug: m.organization.slug }, role: m.role.key, permissions: m.role.permissions })),
    };
  }

  @Post("orgs")
  async createOrg(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateOrgSchema)) body: { name: string }) {
    if (auth.kind !== "user") throw new UnauthorizedException("Only users can create organizations");
    const org = await bootstrapOrganization(this.prisma, { name: body.name, ownerUserId: auth.userId! });
    await appendAudit(this.prisma, { organizationId: org.id, actorType: "user", actorId: auth.userId, action: "org.created", targetType: "organization", targetId: org.id });
    return { organization: org };
  }
}
