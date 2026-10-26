// Imported first by main.ts: instrumentations must patch http/express/prisma before they load.
import { startTelemetry } from "@orbix/engine/telemetry";

export const telemetry = startTelemetry("orbix-api");
