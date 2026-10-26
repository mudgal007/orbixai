import { ExecutionError, classifyHttpStatus } from "@orbix/core";

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** True for non-idempotent writes: a timeout/network error after sending becomes `ambiguous`. */
  write?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

/** fetch with timeout and provider-neutral error classification. */
export async function httpJson<T>(url: string, opts: HttpOptions): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (e) {
    const reason = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
    throw new ExecutionError(opts.write ? "ambiguous" : "transient", `Request ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const failureClass = classifyHttpStatus(res.status);
    const retryAfter = Number(res.headers.get("retry-after"));
    const message = (data as { message?: string })?.message ?? `HTTP ${res.status}`;
    throw new ExecutionError(
      opts.write && failureClass === "transient" && res.status !== 503 ? "ambiguous" : failureClass,
      message,
      { status: res.status, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined },
    );
  }
  return { status: res.status, headers: res.headers, data: data as T };
}
