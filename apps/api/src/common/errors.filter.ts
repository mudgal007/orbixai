import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { ExecutionError } from "@orbix/core";
import { EngineError } from "@orbix/engine";
import type { Response } from "express";

const ENGINE_STATUS: Record<EngineError["code"], number> = { not_found: 404, conflict: 409, invalid: 422, forbidden: 403, gone: 410 };

/** Uniform error envelope: { error: { code, message, details? } }. Internal errors never leak details. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Errors");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    let status = 500;
    let body: { code: string; message: string; details?: unknown } = { code: "internal_error", message: "Something went wrong" };

    if (exception instanceof EngineError) {
      status = ENGINE_STATUS[exception.code];
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof ExecutionError) {
      status = exception.failureClass === "permission" ? 403 : 502;
      body = { code: `provider_${exception.failureClass}`, message: exception.message };
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      body = { code: "rate_limited", message: "Too many requests" };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === "object" && r && "code" in r) body = r as typeof body;
      else body = { code: httpCode(status), message: typeof r === "string" ? r : ((r as { message?: string }).message ?? exception.message) };
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(status).json({ error: body });
  }
}

function httpCode(status: number): string {
  return ({ 400: "bad_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "invalid" } as Record<number, string>)[status] ?? "error";
}
