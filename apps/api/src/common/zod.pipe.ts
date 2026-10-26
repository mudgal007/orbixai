import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

/** Validates request bodies/queries against shared Zod contracts from @orbix/core. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        code: "validation_failed",
        message: r.error.issues[0]?.message ?? "Invalid request",
        details: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return r.data;
  }
}
