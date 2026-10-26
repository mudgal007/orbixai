/**
 * Template references wire node outputs into later node inputs:
 *   "{{nodes.find_issues.output.issues}}"   — whole-value reference keeps the original type
 *   "Found {{nodes.find_issues.output.count}} issues" — interpolated as text
 */
const REF_RE = /\{\{\s*nodes\.([a-z][a-z0-9_]*)\.output((?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
const WHOLE_RE = /^\{\{\s*nodes\.([a-z][a-z0-9_]*)\.output((?:\.[A-Za-z0-9_]+)*)\s*\}\}$/;

export interface TemplateRef {
  nodeId: string;
  path: string[];
}

export function findRefs(value: unknown): TemplateRef[] {
  const out: TemplateRef[] = [];
  walkStrings(value, (s) => {
    for (const m of s.matchAll(REF_RE)) {
      out.push({ nodeId: m[1]!, path: splitPath(m[2] ?? "") });
    }
  });
  return out;
}

export function resolveTemplates(value: unknown, outputs: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_RE.exec(value);
    if (whole) return getPath(outputs[whole[1]!], splitPath(whole[2] ?? ""));
    return value.replace(REF_RE, (_m, nodeId: string, path: string) => {
      const v = getPath(outputs[nodeId], splitPath(path ?? ""));
      if (v === undefined || v === null) return "";
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, outputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveTemplates(v, outputs)]),
    );
  }
  return value;
}

export function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && key === "length") return cur.length;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function splitPath(path: string): string[] {
  return path.split(".").filter(Boolean);
}

function walkStrings(value: unknown, fn: (s: string) => void): void {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, fn));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => walkStrings(v, fn));
}
