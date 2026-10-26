import { ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { sha256 } from "@orbix/core/node";
import type { PrismaClient } from "@orbix/db";
import { IS_PUBLIC, PERMISSION, type OrbixRequest } from "./context";
import { PRISMA } from "./tokens";

export const SESSION_COOKIE = "orbix_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Global guard: authenticates (session cookie or org-bound API key), enforces CSRF header for
 * cookie-authenticated mutations, then — for `/orgs/:orgId/*` routes — resolves membership and
 * checks the route's required permission. Unknown or foreign orgs return 404, not 403.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const cls = ctx.getClass();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, cls])) return true;
    const req = ctx.switchToHttp().getRequest<OrbixRequest>();

    const bearer = req.headers.authorization?.match(/^Bearer\s+(orbx_[A-Za-z0-9_-]+)$/)?.[1];
    if (bearer) {
      const key = await this.prisma.apiKey.findUnique({ where: { keyHash: sha256(bearer) }, include: { role: true } });
      if (!key || key.revokedAt) throw new UnauthorizedException("Invalid API key");
      void this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
      req.orbix = { kind: "api_key", apiKeyId: key.id, organizationId: key.organizationId, roleKey: key.role.key, permissions: key.role.permissions };
    } else {
      const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
      if (!token) throw new UnauthorizedException("Sign in required");
      const session = await this.prisma.session.findUnique({ where: { tokenHash: sha256(token) } });
      if (!session || session.revokedAt || session.expiresAt < new Date()) throw new UnauthorizedException("Session expired");
      if (!SAFE_METHODS.has(req.method) && req.headers["x-orbix-request"] !== "1") {
        throw new ForbiddenException("Missing X-Orbix-Request header");
      }
      if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
        void this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
      }
      req.orbix = { kind: "user", userId: session.userId, permissions: [] };
    }

    const orgId = (req.params as Record<string, string> | undefined)?.orgId;
    const permission = this.reflector.getAllAndOverride<string | undefined>(PERMISSION, [handler, cls]);
    if (orgId) {
      if (req.orbix.kind === "api_key") {
        if (req.orbix.organizationId !== orgId) throw new NotFoundException("Organization not found");
      } else {
        const m = await this.prisma.membership.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId: req.orbix.userId! } },
          include: { role: true },
        });
        if (!m) throw new NotFoundException("Organization not found");
        req.orbix.organizationId = orgId;
        req.orbix.roleKey = m.role.key;
        req.orbix.permissions = m.role.permissions;
      }
      if (permission && !req.orbix.permissions.includes(permission)) {
        throw new ForbiddenException(`Missing permission: ${permission}`);
      }
    } else if (permission) {
      throw new ForbiddenException("Permission-scoped route requires an organization");
    }
    return true;
  }
}
