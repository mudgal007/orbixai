import { z } from "zod";

export const RISK_LEVELS = [
  "read",
  "compute",
  "internal_write",
  "external_write",
  "destructive",
  "financial",
] as const;

export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

/** Deterministic policy: anything externally visible or irreversible needs a human. */
export function approvalRequiredFor(level: RiskLevel): boolean {
  return riskRank(level) >= riskRank("external_write");
}

/** Operations that must never be retried blindly. */
export function isNeverAutoRetry(level: RiskLevel): boolean {
  return level === "destructive" || level === "financial";
}

export function isWrite(level: RiskLevel): boolean {
  return riskRank(level) >= riskRank("internal_write");
}
