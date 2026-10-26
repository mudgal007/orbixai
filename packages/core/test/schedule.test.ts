import { describe, expect, it } from "vitest";
import { checkCron, isValidTimezone, nextRun, nextRuns, validateWorkflow, type WorkflowDefinition } from "../src";

const def = (trigger: WorkflowDefinition["trigger"]): WorkflowDefinition => ({
  schemaVersion: 1,
  name: "t",
  objective: "t",
  trigger,
  nodes: [
    {
      id: "find",
      title: "find",
      agent: "developer",
      action: "github.issues.list_stale_assigned",
      inputs: { staleDays: 7 },
      dependsOn: [],
      timeoutMs: 30_000,
      retry: { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 10_000 },
      risk: "read",
      approval: { required: false, expiresInMinutes: 60 },
    },
  ],
});

describe("cron schedules", () => {
  it("computes next runs in the schedule's timezone", () => {
    const after = new Date("2026-10-26T12:00:00Z");
    // 09:00 in Kolkata (UTC+5:30) is 03:30 UTC
    expect(nextRun("0 9 * * *", "Asia/Kolkata", after).toISOString()).toBe("2026-10-27T03:30:00.000Z");
    expect(nextRun("0 9 * * *", "UTC", after).toISOString()).toBe("2026-10-27T09:00:00.000Z");
  });

  it("skips weekends for weekday schedules", () => {
    // 2026-10-30 is a Friday; the next weekday 09:00 after Friday noon is Monday 2026-11-02.
    const runs = nextRuns("0 9 * * 1-5", "UTC", 2, new Date("2026-10-30T12:00:00Z"));
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-11-02T09:00:00.000Z", "2026-11-03T09:00:00.000Z"]);
  });

  it("follows daylight-saving changes", () => {
    // New York leaves DST on 2026-11-01: 09:00 local is 13:00 UTC before and 14:00 UTC after.
    const runs = nextRuns("0 9 * * *", "America/New_York", 2, new Date("2026-10-31T00:00:00Z"));
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"]);
  });

  it("rejects invalid expressions, unknown timezones and too-frequent schedules", () => {
    expect(checkCron("0 9 * * *", "UTC")).toEqual({ ok: true });
    expect(checkCron("99 * * * *", "UTC").ok).toBe(false);
    expect(checkCron("0 9 * *", "UTC").ok).toBe(false);
    expect(checkCron("0 9 * * *", "Mars/Base").ok).toBe(false);
    expect(checkCron("* * * * *", "UTC")).toMatchObject({ ok: false, reason: expect.stringContaining("5 minutes") });
    expect(checkCron("*/5 * * * *", "UTC").ok).toBe(true);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
  });

  it("validates workflow triggers", () => {
    expect(validateWorkflow(def({ type: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" })).valid).toBe(true);
    const bad = validateWorkflow(def({ type: "schedule", cron: "* * * * *", timezone: "UTC" }));
    expect(bad.issues.map((i) => i.code)).toContain("invalid_schedule");
    const hook = validateWorkflow(def({ type: "webhook", event: "x" }));
    expect(hook.issues.map((i) => i.code)).toContain("trigger_unavailable");
  });
});
