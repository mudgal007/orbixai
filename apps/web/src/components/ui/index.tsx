"use client";

import { forwardRef, useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-indigo-strong text-white hover:bg-indigo shadow-[0_8px_24px_-8px_rgb(91_98_245/0.7)]",
  secondary: "bg-surface-3 text-ink border border-line-strong hover:border-indigo/50",
  ghost: "text-ink-2 hover:text-ink hover:bg-surface-3",
  danger: "bg-critical/15 text-critical border border-critical/30 hover:bg-critical/25",
  success: "bg-good/15 text-good border border-good/30 hover:bg-good/25",
};
const sizes: Record<Size, string> = { sm: "h-8 px-3 text-xs", md: "h-9 px-4 text-sm", lg: "h-11 px-5 text-sm" };

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
          variants[variant],
          sizes[size],
          className,
        )}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
        {children}
      </button>
    );
  },
);

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("glass rounded-xl", className)} {...rest} />;
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-5", className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold tracking-tight text-ink">{title}</h3>
        {description && <p className="mt-1 text-xs text-ink-3">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const tones = {
  neutral: "bg-surface-3 text-ink-2 border-line-strong",
  indigo: "bg-indigo/12 text-indigo border-indigo/30",
  cyan: "bg-cyan/10 text-cyan border-cyan/30",
  good: "bg-good/12 text-good border-good/30",
  warn: "bg-warn/12 text-warn border-warn/30",
  serious: "bg-serious/12 text-serious border-serious/30",
  critical: "bg-critical/12 text-critical border-critical/30",
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = "neutral", className, children, icon }: { tone?: Tone; className?: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap", tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 outline-none transition focus:border-indigo/60 focus:ring-2 focus:ring-indigo/20",
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 outline-none transition focus:border-indigo/60 focus:ring-2 focus:ring-indigo/20",
        className,
      )}
      {...rest}
    />
  );
});

export function Label({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-2">
      <span>{children}</span>
      {hint && <span className="font-normal text-ink-3">{hint}</span>}
    </label>
  );
}

export function Select({ value, onChange, options, className, id, disabled }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; className?: string; id?: string; disabled?: boolean }) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn("h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink outline-none focus:border-indigo/60 disabled:opacity-60", className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-surface-3/70", className)} />;
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-xl border border-line-strong bg-surface-2 text-indigo">{icon}</div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-sm text-xs leading-5 text-ink-3">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-critical/30 bg-critical/8 p-4 text-sm text-critical">
      <p className="font-medium">Something went wrong</p>
      <p className="mt-1 text-xs text-critical/80">{error instanceof Error ? error.message : String(error)}</p>
      {onRetry && (
        <Button size="sm" variant="ghost" className="mt-2 text-critical" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{children}</kbd>;
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cn("glass w-full rounded-2xl shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition", value === t.value ? "bg-surface-3 text-ink shadow-sm" : "text-ink-3 hover:text-ink-2")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: "good" | "warn" | "critical" | "indigo" }) {
  const toneCls = tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : tone === "critical" ? "text-critical" : "text-indigo";
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-xs text-ink-3">
        <span>{label}</span>
        {icon && <span className={toneCls}>{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-ink-3">{hint}</div>}
    </Card>
  );
}

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-80 overflow-auto rounded-lg border border-line bg-bg/70 p-3 font-mono text-[11px] leading-5 text-ink-2", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
