"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  ChevronsUpDown,
  Code2,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Plug,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useOrg } from "@/lib/hooks";
import { useUi } from "@/lib/store";
import { Logo } from "./logo";
import { Dialog, Kbd, Skeleton } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: string;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: "Operate",
    items: [
      { href: "/app", label: "Mission control", icon: LayoutDashboard, shortcut: "g d" },
      { href: "/app/missions/new", label: "New mission", icon: Sparkles, shortcut: "n" },
      { href: "/app/approvals", label: "Approvals", icon: Inbox, shortcut: "g a" },
      { href: "/app/runs", label: "Runs", icon: Activity, shortcut: "g r" },
      { href: "/app/workflows", label: "Workflows", icon: Workflow, shortcut: "g w" },
    ],
  },
  {
    section: "Configure",
    items: [
      { href: "/app/agents", label: "Agents", icon: Bot },
      { href: "/app/integrations", label: "Integrations", icon: Plug, shortcut: "g i" },
      { href: "/app/knowledge", label: "Knowledge", icon: BookOpen },
    ],
  },
  {
    section: "Observe",
    items: [
      { href: "/app/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/app/audit", label: "Audit log", icon: ScrollText },
    ],
  },
  {
    section: "Admin",
    items: [
      { href: "/app/developer", label: "Developer", icon: Code2 },
      { href: "/app/settings", label: "Organization", icon: Settings },
    ],
  },
];
const ALL = NAV.flatMap((s) => s.items);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const { me, org, orgId } = useOrg();
  const { setOrgId, paletteOpen, setPaletteOpen } = useUi();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingKey = useRef<string | null>(null);

  const approvals = useQuery({
    queryKey: ["approvals", orgId, "pending"],
    queryFn: () => api<{ approvals: unknown[] }>(`/orgs/${orgId}/approvals?status=pending`),
    enabled: !!orgId,
    refetchInterval: 10_000,
  });
  const pending = approvals.data?.approvals.length ?? 0;

  useEffect(() => {
    if (me.data && me.data.memberships.length === 0) router.replace("/onboarding");
  }, [me.data, router]);

  useEffect(() => setMobileOpen(false), [pathname]);

  // Keyboard shortcuts: ⌘K / Ctrl+K palette, "g x" navigation, "n" new mission, "?" help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!useUi.getState().paletteOpen);
        return;
      }
      if (target.closest("input, textarea, select, [contenteditable=true]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") return setHelpOpen(true);
      const combo = pendingKey.current ? `${pendingKey.current} ${e.key}` : e.key;
      const hit = ALL.find((i) => i.shortcut === combo);
      if (hit) {
        pendingKey.current = null;
        router.push(hit.href);
      } else if (e.key === "g") {
        pendingKey.current = "g";
        setTimeout(() => (pendingKey.current = null), 1200);
      } else pendingKey.current = null;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, setPaletteOpen]);

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    qc.clear();
    router.replace("/login");
  }

  const isActive = (href: string) => (href === "/app" ? pathname === "/app" : pathname.startsWith(href));

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-4">
        <Link href="/app">
          <Logo size={24} />
        </Link>
        <button className="rounded p-1 text-ink-3 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X className="size-4" />
        </button>
      </div>
      <div className="px-3">
        {me.isLoading ? (
          <Skeleton className="h-10" />
        ) : (
          <label className="relative block">
            <span className="sr-only">Organization</span>
            <select
              value={orgId ?? ""}
              onChange={(e) => {
                setOrgId(e.target.value);
                qc.invalidateQueries();
              }}
              className="h-10 w-full appearance-none rounded-lg border border-line bg-surface-2 pl-3 pr-8 text-sm font-medium text-ink outline-none hover:border-line-strong"
            >
              {me.data?.memberships.map((m) => (
                <option key={m.organization.id} value={m.organization.id}>
                  {m.organization.name}
                </option>
              ))}
            </select>
            <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-3 size-4 text-ink-3" />
          </label>
        )}
        <button onClick={() => setPaletteOpen(true)} className="mt-3 flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 text-xs text-ink-3 hover:border-line-strong">
          <Search className="size-3.5" /> Search or jump to…
          <span className="ml-auto flex gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>
      <nav className="mt-4 flex-1 space-y-5 overflow-y-auto px-3 pb-4" aria-label="Main">
        {NAV.map((section) => (
          <div key={section.section}>
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">{section.section}</div>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive(item.href) ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition",
                      isActive(item.href) ? "bg-indigo/12 text-ink shadow-[inset_2px_0_0_var(--color-indigo)]" : "text-ink-2 hover:bg-surface-3 hover:text-ink",
                    )}
                  >
                    <item.icon className={cn("size-4", isActive(item.href) ? "text-indigo" : "text-ink-3 group-hover:text-ink-2")} />
                    {item.label}
                    {item.href === "/app/approvals" && pending > 0 && (
                      <span className="ml-auto rounded-full bg-warn/20 px-1.5 text-[10px] font-semibold text-warn" aria-label={`${pending} pending`}>
                        {pending}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <div className="grid size-7 place-items-center rounded-full bg-gradient-to-br from-indigo to-cyan text-xs font-semibold text-bg">{me.data?.user.name?.[0]?.toUpperCase() ?? "·"}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{me.data?.user.name}</div>
            <div className="truncate text-[11px] text-ink-3">{me.data?.user.email}</div>
          </div>
          <button onClick={logout} className="rounded p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Sign out" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface/80 backdrop-blur-xl lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface">{sidebar}</aside>
        </div>
      )}
      <div className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur-xl lg:hidden">
        <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="rounded p-1 text-ink-2">
          <Menu className="size-5" />
        </button>
        <Logo size={20} />
        <span className="ml-auto truncate text-xs text-ink-3">{org?.name}</span>
      </div>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">{orgId ? children : <Skeleton className="h-64" />}</main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts">
        <ul className="space-y-2 text-sm">
          <li className="flex justify-between"><span>Command palette</span><span className="flex gap-1"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span></li>
          {ALL.filter((i) => i.shortcut).map((i) => (
            <li key={i.href} className="flex justify-between">
              <span>{i.label}</span>
              <span className="flex gap-1">{i.shortcut!.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
            </li>
          ))}
          <li className="flex justify-between"><span>This help</span><Kbd>?</Kbd></li>
        </ul>
      </Dialog>
    </div>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { orgId } = useOrg();
  const workflows = useQuery({
    queryKey: ["workflows", orgId],
    queryFn: () => api<{ workflows: Array<{ id: string; name: string }> }>(`/orgs/${orgId}/workflows`),
    enabled: open && !!orgId,
  });
  const runs = useQuery({
    queryKey: ["runs", orgId, "palette"],
    queryFn: () => api<{ runs: Array<{ id: string; status: string; workflow: { name: string } }> }>(`/orgs/${orgId}/runs?limit=8`),
    enabled: open && !!orgId,
  });
  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <Command label="Command palette" className="glass w-full max-w-xl overflow-hidden rounded-2xl shadow-2xl" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-ink-3" />
          <Command.Input autoFocus placeholder="Jump to a page, workflow or run…" className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3" />
        </div>
        <Command.List className="max-h-[50vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-ink-3">No results.</Command.Empty>
          <Command.Group heading="Pages" className="text-[11px] text-ink-3 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            {ALL.map((i) => (
              <Command.Item key={i.href} value={`page ${i.label}`} onSelect={() => go(i.href)} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink-2">
                <i.icon className="size-4 text-ink-3" />
                {i.label}
              </Command.Item>
            ))}
          </Command.Group>
          {!!workflows.data?.workflows.length && (
            <Command.Group heading="Workflows" className="text-[11px] text-ink-3 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {workflows.data.workflows.slice(0, 8).map((w) => (
                <Command.Item key={w.id} value={`workflow ${w.name} ${w.id}`} onSelect={() => go(`/app/workflows/${w.id}`)} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink-2">
                  <Workflow className="size-4 text-ink-3" /> {w.name}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {!!runs.data?.runs.length && (
            <Command.Group heading="Recent runs" className="text-[11px] text-ink-3 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {runs.data.runs.map((r) => (
                <Command.Item key={r.id} value={`run ${r.workflow.name} ${r.id}`} onSelect={() => go(`/app/runs/${r.id}`)} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink-2">
                  <Activity className="size-4 text-ink-3" /> {r.workflow.name} <span className="ml-auto text-[11px] text-ink-3">{r.status.toLowerCase()}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}
