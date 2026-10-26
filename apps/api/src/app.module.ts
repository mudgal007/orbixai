import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { CredentialBroker } from "@orbix/connectors";
import { getPrisma, type PrismaClient } from "@orbix/db";
import { ExecutionEngine, Scheduler, createModelFromEnv, type ModelClient } from "@orbix/engine";
import { hostname } from "node:os";
import { AuthGuard } from "./common/auth.guard";
import { ErrorsFilter } from "./common/errors.filter";
import { BROKER, ENGINE, MODEL, PRISMA, SCHEDULER } from "./common/tokens";
import { AuthController } from "./modules/auth.controller";
import { DeveloperController } from "./modules/developer.controller";
import { InsightsController } from "./modules/insights.controller";
import { IntegrationsController } from "./modules/integrations.controller";
import { OrgController } from "./modules/org.controller";
import { RunsController } from "./modules/runs.controller";
import { SchedulesController } from "./modules/schedules.controller";
import { WorkflowsController } from "./modules/workflows.controller";

@Module({
  imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: Number(process.env.ORBIX_RATE_LIMIT_PER_MIN ?? 300) }])],
  controllers: [AuthController, OrgController, IntegrationsController, WorkflowsController, RunsController, SchedulesController, InsightsController, DeveloperController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrisma() },
    { provide: MODEL, useFactory: () => createModelFromEnv() },
    { provide: BROKER, useFactory: (prisma: PrismaClient) => new CredentialBroker(prisma), inject: [PRISMA] },
    {
      provide: ENGINE,
      // The API uses the engine only for run lifecycle and approvals; task execution happens in apps/worker.
      useFactory: (prisma: PrismaClient, model: ModelClient, broker: CredentialBroker) =>
        new ExecutionEngine({ prisma, model, broker, workerId: `api:${hostname()}:${process.pid}`, leaseMs: 60_000 }),
      inject: [PRISMA, MODEL, BROKER],
    },
    { provide: SCHEDULER, useFactory: (prisma: PrismaClient, engine: ExecutionEngine) => new Scheduler(prisma, engine), inject: [PRISMA, ENGINE] },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}
