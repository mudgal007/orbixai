import { CronExpressionParser } from "cron-parser";

/** Schedules may not fire more often than this (abuse and cost protection). */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 5;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type CronCheck = { ok: true } | { ok: false; reason: string };

/** Validates a 5-field cron expression, its timezone, and the minimum interval policy. */
export function checkCron(cron: string, timezone: string): CronCheck {
  if (cron.trim().split(/\s+/).length !== 5) return { ok: false, reason: "Use a 5-field cron expression (minute hour day month weekday)" };
  if (!isValidTimezone(timezone)) return { ok: false, reason: `Unknown timezone "${timezone}"` };
  let times: Date[];
  try {
    times = nextRuns(cron, timezone, 3);
  } catch (e) {
    return { ok: false, reason: `Invalid cron expression: ${(e as Error).message}` };
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i]!.getTime() - times[i - 1]!.getTime() < MIN_SCHEDULE_INTERVAL_MINUTES * 60_000) {
      return { ok: false, reason: `Schedules may run at most every ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes` };
    }
  }
  return { ok: true };
}

/** The next `count` fire times strictly after `after`, evaluated in `timezone`. */
export function nextRuns(cron: string, timezone: string, count: number, after: Date = new Date()): Date[] {
  const it = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone });
  return Array.from({ length: count }, () => it.next().toDate());
}

export function nextRun(cron: string, timezone: string, after: Date = new Date()): Date {
  return nextRuns(cron, timezone, 1, after)[0]!;
}

export const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every weekday at 9:00", cron: "0 9 * * 1-5" },
  { label: "Every day at 9:00", cron: "0 9 * * *" },
  { label: "Every Monday at 9:00", cron: "0 9 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
];
