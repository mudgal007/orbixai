const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[_-]?key|cookie|credential|private[_-]?key)/i;
const INLINE_SECRET = /\b(xox[abpr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|orbx_[A-Za-z0-9_]{20,})\b/g;

/** Redacts secrets by key name and by well-known token shapes. Used for traces, logs and audit. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return "[depth-limit]" as T;
  if (typeof value === "string") return value.replace(INLINE_SECRET, "[REDACTED]") as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) && v !== null && typeof v !== "object" ? "[REDACTED]" : redact(v, depth + 1),
      ]),
    ) as T;
  }
  return value;
}
