"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Bot, Briefcase, CircleDollarSign, Code2, Lock, MessageSquare, Search, ShieldCheck, Users } from "lucide-react";
import type { WorkflowDefinition, WorkflowNode } from "@orbix/core";
import { cn } from "@/lib/cn";
import { RiskBadge, StatusBadge } from "./status";

export const AGENT_META: Record<string, { label: string; icon: typeof Bot; color: string }> = {
  research: { label: "Research", icon: Search, color: "#7c83ff" },
  data_analysis: { label: "Data Analysis", icon: BarChart3, color: "#a78bfa" },
  communication: { label: "Communication", icon: MessageSquare, color: "#38d6f0" },
  crm: { label: "CRM", icon: Users, color: "#f472b6" },
  finance_ops: { label: "Finance Ops", icon: CircleDollarSign, color: "#fab219" },
  developer: { label: "Developer", icon: Code2, color: "#60a5fa" },
  verification: { label: "Verification", icon: ShieldCheck, color: "#22c55e" },
  supervisor: { label: "Supervisor", icon: Briefcase, color: "#c084fc" },
};

interface NodeData extends Record<string, unknown> {
  node: WorkflowNode;
  status?: string;
  attempt?: number;
  issues?: number;
  selected?: boolean;
}

const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<NodeData>>) {
  const { node, status, issues, attempt } = data;
  const meta = AGENT_META[node.agent] ?? { label: node.agent, icon: Bot, color: "#7c83ff" };
  const Icon = meta.icon;
  const running = status === "RUNNING";
  const waiting = status === "WAITING_APPROVAL";
  return (
    <div
      className={cn(
        "w-[240px] rounded-xl border bg-surface-2/95 p-3 shadow-xl backdrop-blur transition",
        data.selected ? "border-indigo shadow-glow" : "border-line-strong",
        running && "pulse-ring border-cyan/60",
        waiting && "border-warn/60",
        status === "SUCCEEDED" && "border-good/40",
        (status === "FAILED" || status === "DEAD_LETTER") && "border-critical/60",
        status === "SKIPPED" && "opacity-50",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-start gap-2.5">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: `${meta.color}1f`, color: meta.color }}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-5 text-ink">{node.title}</div>
          <div className="truncate font-mono text-[10px] text-ink-3">{node.action}</div>
        </div>
        {node.approval.required && <Lock className="mt-0.5 size-3.5 shrink-0 text-warn" aria-label="Requires approval" />}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-ink-3">{meta.label}</span>
        <RiskBadge risk={node.risk} />
        {status && <StatusBadge status={status} />}
        {!!attempt && attempt > 1 && <span className="text-[10px] text-warn">attempt {attempt}</span>}
        {!!issues && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-critical">
            <AlertTriangle className="size-3" /> {issues}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { agent: AgentNode };

export interface MissionGraphProps {
  definition: WorkflowDefinition;
  editable?: boolean;
  statuses?: Record<string, { status: string; attempt?: number }>;
  issuesByNode?: Record<string, number>;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (def: WorkflowDefinition) => void;
  className?: string;
}

function toEdges(def: WorkflowDefinition, statuses?: MissionGraphProps["statuses"]): Edge[] {
  return def.nodes.flatMap((n) =>
    n.dependsOn.map((d) => {
      const active = statuses?.[n.id]?.status === "RUNNING" || statuses?.[n.id]?.status === "READY";
      const done = statuses?.[d]?.status === "SUCCEEDED";
      return {
        id: `${d}->${n.id}`,
        source: d,
        target: n.id,
        animated: active && done,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "rgba(148,163,255,0.5)" },
        style: { strokeWidth: 1.5, stroke: done ? "rgba(56,214,240,0.55)" : undefined },
      } satisfies Edge;
    }),
  );
}

function Graph({ definition, editable, statuses, issuesByNode, selectedId, onSelect, onChange, className }: MissionGraphProps) {
  const build = useCallback(
    (def: WorkflowDefinition): Node<NodeData>[] =>
      def.nodes.map((n) => ({
        id: n.id,
        type: "agent",
        position: n.position ?? { x: 0, y: 0 },
        data: { node: n, status: statuses?.[n.id]?.status, attempt: statuses?.[n.id]?.attempt, issues: issuesByNode?.[n.id], selected: selectedId === n.id },
        draggable: !!editable,
        connectable: !!editable,
        deletable: !!editable,
      })),
    [statuses, issuesByNode, selectedId, editable],
  );
  const [nodes, setNodes] = useState<Node<NodeData>[]>(() => build(definition));
  useEffect(() => setNodes(build(definition)), [definition, build]);
  const edges = useMemo(() => toEdges(definition, statuses), [definition, statuses]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<NodeData>>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (!editable || !onChange) return;
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      const moved = changes.filter((c): c is Extract<NodeChange, { type: "position" }> => c.type === "position" && !c.dragging && !!c.position);
      if (removed.length) {
        onChange({
          ...definition,
          nodes: definition.nodes.filter((n) => !removed.includes(n.id)).map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => !removed.includes(d)) })),
        });
        onSelect?.(null);
      } else if (moved.length) {
        onChange({ ...definition, nodes: definition.nodes.map((n) => { const m = moved.find((c) => c.id === n.id); return m?.position ? { ...n, position: m.position } : n; }) });
      }
    },
    [definition, editable, onChange, onSelect],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!editable || !onChange) return;
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (!removed.length) return;
      onChange({ ...definition, nodes: definition.nodes.map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => !removed.includes(`${d}->${n.id}`)) })) });
    },
    [definition, editable, onChange],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!editable || !onChange || !c.source || !c.target || c.source === c.target) return;
      onChange({ ...definition, nodes: definition.nodes.map((n) => (n.id === c.target && !n.dependsOn.includes(c.source!) ? { ...n, dependsOn: [...n.dependsOn, c.source!] } : n)) });
    },
    [definition, editable, onChange],
  );

  return (
    <div className={cn("relative size-full", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        fitView
        fitViewOptions={{ padding: 0.15, minZoom: 0.6, maxZoom: 1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        nodesDraggable={!!editable}
        nodesConnectable={!!editable}
        elementsSelectable
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(148,163,255,0.14)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => AGENT_META[(n.data as NodeData).node.agent]?.color ?? "#7c83ff"} maskColor="rgba(6,10,20,0.7)" className="!hidden 2xl:!block" />
      </ReactFlow>
    </div>
  );
}

export function MissionGraph(props: MissionGraphProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
