"use client";

import { motion } from "framer-motion";
import { Bot, CheckCircle2, GitBranch, Lock, MessageSquare, ShieldCheck } from "lucide-react";

const NODES = [
  { x: 2, y: 44, label: "Stale issues", icon: GitBranch, tone: "text-ink-2" },
  { x: 28, y: 20, label: "Summarize", icon: Bot, tone: "text-indigo" },
  { x: 28, y: 68, label: "Plan", icon: Bot, tone: "text-indigo" },
  { x: 54, y: 44, label: "Draft", icon: MessageSquare, tone: "text-cyan" },
  { x: 80, y: 24, label: "Approval", icon: Lock, tone: "text-warn" },
  { x: 80, y: 64, label: "Verify", icon: ShieldCheck, tone: "text-good" },
];
const EDGES: Array<[number, number]> = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 5]];

/** Decorative illustration of a mission graph (marketing page only; not data). */
export function HeroGraph() {
  return (
    <div className="glass grid-bg relative aspect-[4/3] w-full overflow-hidden rounded-2xl" aria-hidden>
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {EDGES.map(([a, b], i) => {
          const s = NODES[a]!;
          const t = NODES[b]!;
          // Nodes are 17% wide and ~12% tall: connect right-middle of source to left-middle of target.
          const sx = s.x + 17, sy = s.y + 6, tx = t.x, ty = t.y + 6, mx = (sx + tx) / 2;
          // Stacked nodes (same column) connect bottom-centre to top-centre.
          const d =
            s.x === t.x
              ? `M ${s.x + 8.5} ${s.y + 12} L ${t.x + 8.5} ${t.y}`
              : `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
          return (
            <motion.path
              key={i}
              d={d}
              fill="none"
              stroke="url(#edge)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ delay: 0.3 + i * 0.25, duration: 0.6 }}
            />
          );
        })}
        <defs>
          <linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
            <stop offset="0" stopColor="#7c83ff" stopOpacity="0.7" />
            <stop offset="1" stopColor="#38d6f0" stopOpacity="0.7" />
          </linearGradient>
        </defs>
      </svg>
      {NODES.map((n, i) => (
        <motion.div
          key={n.label}
          className="absolute flex items-center gap-2 rounded-lg border border-line-strong bg-surface-2/90 h-[12%] px-2 text-[11px] shadow-lg sm:text-xs"
          style={{ left: `${n.x}%`, top: `${n.y}%`, width: "17%" }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 + i * 0.22 }}
        >
          <n.icon className={`size-3.5 shrink-0 ${n.tone}`} />
          <span className="truncate">{n.label}</span>
          {i === 5 && <CheckCircle2 className="ml-auto size-3.5 shrink-0 text-good" />}
        </motion.div>
      ))}
    </div>
  );
}
