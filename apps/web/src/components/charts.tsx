"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CheckCircle2, CircleDot, XCircle } from "lucide-react";

// Chart roles (see globals.css). Status steps validated against the dark surface; red/green are not
// CVD-separable on their own, so the neutral series sits between them and every series has an icon label.
const C = { good: "#0ca30c", neutral: "#64748b", critical: "#d03b3b", series1: "#3987e5", surface: "#0b1120", grid: "rgba(148,163,255,0.08)", axis: "#6b7594" };

const SERIES = [
  { key: "succeeded", label: "Succeeded", color: C.good, icon: CheckCircle2 },
  { key: "other", label: "In progress / other", color: C.neutral, icon: CircleDot },
  { key: "failed", label: "Failed", color: C.critical, icon: XCircle },
] as const;

interface Point {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
}

function TooltipBox({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 font-medium text-ink">{label}</div>
      {SERIES.map((s) => {
        const v = payload.find((p) => p.dataKey === s.key)?.value ?? 0;
        return (
          <div key={s.key} className="flex items-center gap-2 text-ink-2">
            <s.icon className="size-3" style={{ color: s.color }} /> {s.label}
            <span className="ml-auto pl-4 tabular-nums text-ink">{v}</span>
          </div>
        );
      })}
    </div>
  );
}

export function RunsChart({ data }: { data: Point[] }) {
  const rows = data.map((d) => ({ ...d, label: new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) }));
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-4 text-[11px] text-ink-2" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <s.icon className="size-3.5" style={{ color: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="h-56" role="img" aria-label="Runs per day by final status">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 4, left: -24, bottom: 0 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: C.axis, fontSize: 11 }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: C.axis, fontSize: 11 }} />
            <Tooltip cursor={{ fill: "rgba(148,163,255,0.06)" }} content={<TooltipBox />} />
            <Bar dataKey="succeeded" stackId="s" fill={C.good} stroke={C.surface} strokeWidth={2} />
            <Bar dataKey="other" stackId="s" fill={C.neutral} stroke={C.surface} strokeWidth={2} />
            <Bar dataKey="failed" stackId="s" fill={C.critical} stroke={C.surface} strokeWidth={2} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-[11px] text-ink-3">
        <summary className="cursor-pointer select-none">View as table</summary>
        <table className="mt-2 w-full text-left">
          <thead><tr><th className="py-1 font-medium">Date</th><th className="font-medium">Succeeded</th><th className="font-medium">Other</th><th className="font-medium">Failed</th></tr></thead>
          <tbody>{rows.filter((r) => r.succeeded + r.failed + r.other > 0).map((r) => <tr key={r.date}><td className="py-0.5">{r.label}</td><td>{r.succeeded}</td><td>{r.other}</td><td>{r.failed}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** Single-series horizontal bars (one hue; the title names the measure, so no legend). */
export function HBarChart({ data, format }: { data: Array<{ label: string; value: number }>; format: (n: number) => string }) {
  return (
    <div style={{ height: Math.max(80, data.length * 36) }} role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join(", ")}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 48, left: 0, bottom: 0 }} barCategoryGap="30%">
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={150} tickLine={false} axisLine={false} tick={{ fill: C.axis, fontSize: 11 }} />
          <Tooltip cursor={{ fill: "rgba(148,163,255,0.06)" }} formatter={(v: number) => format(v)} contentStyle={{ background: "#0f1729", border: "1px solid rgba(148,163,255,0.18)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#e8ecf8" }} itemStyle={{ color: "#a6b0cc" }} />
          <Bar dataKey="value" fill={C.series1} radius={[0, 4, 4, 0]} label={{ position: "right", fill: "#a6b0cc", fontSize: 11, formatter: (v: unknown) => format(Number(v)) }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
