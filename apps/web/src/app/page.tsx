import Link from "next/link";
import { ArrowRight, Check, Eye, FlaskConical, GitBranch, Lock, RotateCcw, ShieldCheck, Sparkles, Workflow } from "lucide-react";
import { Logo } from "@/components/logo";
import { HeroGraph } from "@/components/hero-graph";

const PILLARS = [
  { icon: Sparkles, title: "Goal → typed graph", body: "Describe an outcome. ORBIX compiles it into an editable, versioned DAG of agent tasks with explicit inputs, outputs, retries and risk." },
  { icon: FlaskConical, title: "Simulate before you act", body: "Plan Preview with zero I/O, Dry Run against sandbox connectors, then Live. See cost, API calls and every side effect up front." },
  { icon: Lock, title: "Payload-bound approvals", body: "Approvals sign the exact payload hash and expire. Change one character and the approval is invalidated automatically." },
  { icon: RotateCcw, title: "Recovery, not retries", body: "Failures are classified. Ambiguous writes are reconciled against the provider before any retry — no duplicate sends." },
  { icon: ShieldCheck, title: "Verified outcomes", body: "Completed, acknowledged and independently verified are different states. ORBIX re-reads provider state to prove the result." },
  { icon: Eye, title: "Deterministic security", body: "Models have no tools. Every call is authorised by backend policy at execution time; credentials never enter prompts." },
];

const COMPARE: Array<[string, string, string, string]> = [
  ["Authoring", "Hand-wired steps", "Prompt + tools", "Goal → editable typed DAG"],
  ["Pre-flight", "—", "—", "Plan preview, dry run, cost model"],
  ["Approvals", "Optional, coarse", "Rare", "Bound to payload hash, expiring"],
  ["Failures", "Retry N times", "Re-prompt", "Taxonomy + reconciliation"],
  ["Outcome", "Step returned 200", "Agent said done", "Independently verified"],
];

export default function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          <a href="#how" className="hidden px-3 py-2 text-ink-2 hover:text-ink sm:inline">How it works</a>
          <a href="#compare" className="hidden px-3 py-2 text-ink-2 hover:text-ink sm:inline">Why ORBIX</a>
          <Link href="/login" className="px-3 py-2 text-ink-2 hover:text-ink">Sign in</Link>
          <Link href="/signup" className="rounded-lg bg-indigo-strong px-4 py-2 font-medium text-white hover:bg-indigo">Get started</Link>
        </nav>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-16">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface-2 px-3 py-1 text-xs text-ink-2">
            <span className="size-1.5 rounded-full bg-cyan" /> The control plane for autonomous work
          </span>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
            Autonomy you can <span className="bg-gradient-to-r from-indigo to-cyan bg-clip-text text-transparent">prove.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-ink-2 sm:text-lg">
            ORBIX turns a business goal into a secure execution graph, simulates it, asks for approval on the exact action, runs it durably, and verifies the outcome against real systems.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/signup" className="inline-flex h-11 items-center gap-2 rounded-lg bg-indigo-strong px-5 text-sm font-medium text-white shadow-glow hover:bg-indigo">
              Start a mission <ArrowRight className="size-4" />
            </Link>
            <Link href="/login" className="inline-flex h-11 items-center rounded-lg border border-line-strong px-5 text-sm text-ink hover:border-indigo/50">
              Open console
            </Link>
          </div>
          <p className="mt-6 text-xs text-ink-3">Runs locally with sandbox GitHub and Slack connectors — no credentials required to try it.</p>
        </div>
        <HeroGraph />
      </section>

      <section id="how" className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">Built around the mission graph</h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">Every capability exists to make autonomous work safe to delegate.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="glass rounded-xl p-5 transition hover:border-indigo/30">
              <div className="mb-3 grid size-9 place-items-center rounded-lg bg-indigo/12 text-indigo">
                <Icon className="size-4" />
              </div>
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-ink-2">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="compare" className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">Not another trigger-action builder</h2>
        <div className="glass mt-6 overflow-x-auto rounded-xl">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className="px-5 py-3 font-medium" />
                <th className="px-5 py-3 font-medium">Trigger→action tools</th>
                <th className="px-5 py-3 font-medium">Agent builders</th>
                <th className="px-5 py-3 font-medium text-indigo">ORBIX</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([k, a, b, c]) => (
                <tr key={k} className="border-b border-line last:border-0">
                  <td className="px-5 py-3 text-ink-2">{k}</td>
                  <td className="px-5 py-3 text-ink-3">{a}</td>
                  <td className="px-5 py-3 text-ink-3">{b}</td>
                  <td className="px-5 py-3 text-ink">
                    <span className="inline-flex items-center gap-2"><Check className="size-3.5 text-good" />{c}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="glass flex flex-col gap-6 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Integrations, honestly labelled</h2>
            <p className="mt-2 text-sm text-ink-2">
              <span className="text-ink">Available:</span> GitHub, Slack (OAuth, developer token, or sandbox). <span className="text-ink">Roadmap:</span> Gmail, Calendar, HubSpot, Shopify, Stripe, Notion, Linear, MCP.
            </p>
          </div>
          <div className="flex gap-2 text-ink-3">
            <GitBranch className="size-5" />
            <Workflow className="size-5" />
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-ink-3 sm:flex-row sm:justify-between sm:px-6">
          <Logo size={20} />
          <span>Self-hosted MVP · OpenAPI at <code className="font-mono">/docs</code></span>
        </div>
      </footer>
    </div>
  );
}
