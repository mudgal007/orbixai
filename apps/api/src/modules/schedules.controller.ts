import { Body, Controller, Get, Inject, Param, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { UpdateScheduleSchema } from "@orbix/core";
import type { Scheduler } from "@orbix/engine";
import { Auth, RequirePermission, actorOf, type AuthContext } from "../common/context";
import { SCHEDULER } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

@ApiTags("schedules")
@Controller("orgs/:orgId")
export class SchedulesController {
  constructor(@Inject(SCHEDULER) private readonly scheduler: Scheduler) {}

  @Get("schedules")
  @RequirePermission("workflow:read")
  async list(@Param("orgId") orgId: string) {
    return { schedules: await this.scheduler.list(orgId) };
  }

  @Get("workflows/:id/schedule")
  @RequirePermission("workflow:read")
  async get(@Param("orgId") orgId: string, @Param("id") id: string) {
    return { schedule: await this.scheduler.get(orgId, id) };
  }

  /** Cron and timezone come from the published trigger; this toggles activation and dry-run/live. */
  @Put("workflows/:id/schedule")
  @RequirePermission("run:execute")
  async update(@Param("orgId") orgId: string, @Param("id") id: string, @Auth() auth: AuthContext, @Body(new ZodPipe(UpdateScheduleSchema)) body: { enabled?: boolean; mode?: "dry_run" | "live" }) {
    return { schedule: await this.scheduler.update({ organizationId: orgId, workflowId: id, ...body, actor: actorOf(auth) }) };
  }
}
