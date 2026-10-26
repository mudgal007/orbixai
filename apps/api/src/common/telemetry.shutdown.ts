import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { telemetry } from "../tracing";

/** Flushes buffered spans when Nest shuts down (SIGTERM via enableShutdownHooks). */
@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await telemetry.shutdown();
  }
}
