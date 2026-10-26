"use client";

import { useEffect, useState } from "react";
import { Lock, Trash2 } from "lucide-react";
import { AGENTS, RISK_LEVELS, approvalRequiredFor, getCapability, riskRank, type ValidationIssue, type WorkflowNode } from "@orbix/core";
import { RiskBadge } from "./status";
import { Badge, Button, Input, Label, Select, Textarea } from "./ui";

export function NodeInspector({ node, issues, onChange, onDelete, readOnly }: { node: WorkflowNode; issues: ValidationIssue[]; onChange: (n: WorkflowNode) => void; onDelete: () => void; readOnly?: boolean }) {
  const cap = getCapability(node.action);
  const agents = AGENTS.filter((a) => a.allowedCapabilities.includes(node.action));
  const forcedApproval = approvalRequiredFor(node.risk);
  const set = (patch: Partial<WorkflowNode>) => onChange({ ...node, ...patch });

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-ink-3">{node.id}</span>
          <RiskBadge risk={node.risk} />
        </div>
        <p className="mt-2 text-xs leading-5 text-ink-3">{cap?.description ?? "Unknown capability"}</p>
        {cap?.sideEffect && <p className="mt-1 text-xs text-warn">Side effect: {cap.sideEffect}</p>}
      </div>

      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-critical/30 bg-critical/8 p-2.5 text-xs">
          {issues.map((i, k) => (
            <li key={k} className={i.severity === "error" ? "text-critical" : "text-warn"}>
              {i.message}
            </li>
          ))}
        </ul>
      )}

      <fieldset disabled={readOnly} className="space-y-4">
        <div>
          <Label htmlFor="n-title">Title</Label>
          <Input id="n-title" value={node.title} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="n-agent" hint="tool allowlist enforced">Agent</Label>
          <Select id="n-agent" value={node.agent} onChange={(v) => set({ agent: v as WorkflowNode["agent"] })} options={(agents.length ? agents : AGENTS).map((a) => ({ value: a.key, label: a.name }))} />
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold text-ink-2">Inputs</div>
          <div className="space-y-3">
            {Object.entries(cap?.inputs ?? {}).map(([key, spec]) => (
              <InputField key={key} name={key} required={spec.required} description={spec.description} value={node.inputs[key]} onChange={(v) => set({ inputs: { ...node.inputs, [key]: v } })} />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            Reference upstream outputs with <code className="font-mono text-ink-2">{"{{nodes.<id>.output.<field>}}"}</code>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="n-risk">Risk</Label>
            <Select
              id="n-risk"
              value={node.risk}
              onChange={(v) => set({ risk: v as WorkflowNode["risk"] })}
              options={RISK_LEVELS.filter((r) => !cap || riskRank(r) >= riskRank(cap.risk)).map((r) => ({ value: r, label: r.replace("_", " ") }))}
            />
          </div>
          <div>
            <Label htmlFor="n-timeout">Timeout (s)</Label>
            <Input id="n-timeout" type="number" min={1} max={900} value={Math.round(node.timeoutMs / 1000)} onChange={(e) => set({ timeoutMs: Math.max(1, Number(e.target.value)) * 1000 })} />
          </div>
          <div>
            <Label htmlFor="n-attempts">Max attempts</Label>
            <Input id="n-attempts" type="number" min={1} max={10} value={node.retry.maxAttempts} onChange={(e) => set({ retry: { ...node.retry, maxAttempts: Number(e.target.value) } })} />
          </div>
          <div>
            <Label htmlFor="n-backoff">Backoff (ms)</Label>
            <Input id="n-backoff" type="number" min={100} max={60000} value={node.retry.backoffMs} onChange={(e) => set({ retry: { ...node.retry, backoffMs: Number(e.target.value) } })} />
          </div>
        </div>
        {cap && !cap.idempotent && !cap.reconcilable && <p className="text-[11px] text-ink-3">This action is not idempotent; automatic retries are disabled by policy.</p>}

        <div className="rounded-lg border border-line bg-surface p-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-[var(--color-indigo)]" checked={node.approval.required || forcedApproval} disabled={forcedApproval || readOnly} onChange={(e) => set({ approval: { ...node.approval, required: e.target.checked } })} />
            Require human approval
            {forcedApproval && (
              <Badge tone="warn" icon={<Lock className="size-3" />}>
                Policy
              </Badge>
            )}
          </label>
          {(node.approval.required || forcedApproval) && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="n-exp">Expires (min)</Label>
                <Input id="n-exp" type="number" min={1} value={node.approval.expiresInMinutes} onChange={(e) => set({ approval: { ...node.approval, expiresInMinutes: Number(e.target.value) } })} />
              </div>
              <div>
                <Label htmlFor="n-role">Approver role</Label>
                <Select id="n-role" value={node.approval.approverRole ?? ""} onChange={(v) => set({ approval: { ...node.approval, approverRole: v || undefined } })} options={[{ value: "", label: "Any approver" }, { value: "approver", label: "Approver" }, { value: "admin", label: "Admin" }, { value: "owner", label: "Owner" }]} />
              </div>
            </div>
          )}
        </div>

        {node.successCondition && (
          <div className="text-xs text-ink-3">
            Success when <code className="font-mono text-ink-2">{node.successCondition.path}</code> {node.successCondition.op} {node.successCondition.value !== undefined && <code className="font-mono text-ink-2">{JSON.stringify(node.successCondition.value)}</code>}
          </div>
        )}
        {node.compensation && <div className="text-xs text-ink-3">Recovery: {node.compensation.note}</div>}
      </fieldset>

      {!readOnly && (
        <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
          Remove step
        </Button>
      )}
    </div>
  );
}

function InputField({ name, value, onChange, required, description }: { name: string; value: unknown; onChange: (v: unknown) => void; required?: boolean; description: string }) {
  const isScalar = typeof value === "string" || typeof value === "number" || value === undefined;
  const [text, setText] = useState(() => (isScalar ? "" : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (!isScalar) setText(JSON.stringify(value, null, 2));
  }, [value, isScalar]);

  return (
    <div>
      <Label htmlFor={`in-${name}`} hint={required ? "required" : undefined}>
        <span className="font-mono">{name}</span>
      </Label>
      {isScalar ? (
        typeof value === "number" ? (
          <Input id={`in-${name}`} type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
        ) : (
          <Input id={`in-${name}`} value={(value as string | undefined) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={description} className="font-mono text-xs" />
        )
      ) : (
        <Textarea
          id={`in-${name}`}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            try {
              onChange(JSON.parse(text));
              setBad(false);
            } catch {
              setBad(true);
            }
          }}
          className={`font-mono text-[11px] ${bad ? "border-critical" : ""}`}
        />
      )}
      {bad && <p className="mt-1 text-[11px] text-critical">Invalid JSON — not applied</p>}
    </div>
  );
}
