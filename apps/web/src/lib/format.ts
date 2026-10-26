export function timeAgo(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : new Intl.NumberFormat("en").format(n));
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);

export function timeUntil(date: string | Date): string {
  const s = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  if (s <= 0) return "expired";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}
