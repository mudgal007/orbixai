/** Typed fetch wrapper for the ORBIX API (same-origin via the Next rewrite). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    signal: init.signal,
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-Orbix-Request": "1" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && typeof window !== "undefined" && window.location.pathname.startsWith("/app")) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}
