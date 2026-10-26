export const PERMISSIONS = [
  "org:manage",
  "member:read",
  "member:manage",
  "workflow:read",
  "workflow:write",
  "run:execute",
  "approval:decide",
  "connection:manage",
  "apikey:manage",
  "audit:read",
  "knowledge:write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES: Record<string, { name: string; permissions: readonly Permission[] }> = {
  owner: { name: "Owner", permissions: PERMISSIONS },
  admin: { name: "Admin", permissions: PERMISSIONS.filter((p) => p !== "org:manage") },
  operator: {
    name: "Operator",
    permissions: ["member:read", "workflow:read", "workflow:write", "run:execute", "approval:decide", "knowledge:write"],
  },
  approver: { name: "Approver", permissions: ["member:read", "workflow:read", "approval:decide"] },
  viewer: { name: "Viewer", permissions: ["member:read", "workflow:read"] },
};
export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
