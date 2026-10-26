import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Permission } from "@orbix/core";
import type { Actor } from "@orbix/engine";
import type { Request } from "express";

export interface AuthContext {
  kind: "user" | "api_key";
  userId?: string;
  apiKeyId?: string;
  /** Set for API keys (bound to one org) and after OrgGuard resolves membership. */
  organizationId?: string;
  roleKey?: string;
  permissions: string[];
}

export type OrbixRequest = Request & { orbix?: AuthContext };

export const IS_PUBLIC = "orbix:public";
export const PERMISSION = "orbix:permission";

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Org-scoped route (`:orgId` param) requiring this permission in the caller's role. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<OrbixRequest>();
  if (!req.orbix) throw new Error("Auth context missing");
  return req.orbix;
});

export function actorOf(auth: AuthContext): Actor & { roleKey?: string } {
  return auth.kind === "user"
    ? { type: "user", id: auth.userId, roleKey: auth.roleKey }
    : { type: "api_key", id: auth.apiKeyId, roleKey: auth.roleKey };
}
