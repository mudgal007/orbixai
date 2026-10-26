import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { getPrisma, syncIntegrationCatalog } from "@orbix/db";
import { AppModule } from "./app.module";

// RunEvent ids are BIGINT; serialise as strings in JSON responses.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: opts.logger === false ? false : ["log", "warn", "error"] });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.enableCors({ origin: process.env.ORBIX_WEB_URL ?? "http://localhost:3000", credentials: true });
  app.setGlobalPrefix("v1", { exclude: ["docs", "docs-json"] });
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle("ORBIX AI API")
    .setDescription("Control plane for autonomous work. Authenticate with a session cookie or `Authorization: Bearer orbx_…`.")
    .setVersion("1.0")
    .addBearerAuth({ type: "http", scheme: "bearer", description: "Org-bound API key (orbx_…)" })
    .addCookieAuth("orbix_session")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config), { jsonDocumentUrl: "docs-json" });
  await syncIntegrationCatalog(getPrisma());
  return app;
}
