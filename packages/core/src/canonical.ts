/** Deterministic JSON: object keys sorted recursively, undefined dropped. Used for payload hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
