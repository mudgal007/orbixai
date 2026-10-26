/**
 * Prompt-injection defences. The structural defence is that models in ORBIX have NO tools: every tool
 * call comes from the published graph and is checked by deterministic policy. These helpers add
 * content fencing and detection so suspicious inputs are visible in traces and approvals.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all |any )?(previous|prior|above) (instructions|prompts)/i, "instruction override"],
  [/disregard (the )?(system|previous) (prompt|instructions)/i, "instruction override"],
  [/(reveal|print|post|send|share).{0,40}(token|api key|password|secret|credential)/i, "credential exfiltration"],
  [/you are now|act as (an? )?(admin|system|developer)/i, "role hijack"],
  [/<\/?untrusted/i, "fence escape"],
];

export interface InjectionFinding {
  source: string;
  kind: string;
  excerpt: string;
}

export function detectInjection(text: string, source: string): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  for (const [re, kind] of PATTERNS) {
    const m = re.exec(text);
    if (m) out.push({ source, kind, excerpt: text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim() });
  }
  return out;
}

/** Wraps external data so the model treats it as content; neutralises attempts to close the fence. */
export function fenceUntrusted(source: string, data: unknown): string {
  const body = (typeof data === "string" ? data : JSON.stringify(data, null, 2)).replace(/<\/?untrusted[^>]*>/gi, "[removed-tag]");
  return `<untrusted source="${source.replace(/"/g, "")}">\n${body}\n</untrusted>`;
}

export function scanValue(value: unknown, source: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") findings.push(...detectInjection(v, path));
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
  };
  walk(value, source);
  return findings;
}

/** Removes HTML comments (a common hiding place for injected instructions) from source text. */
export function stripHidden(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}
