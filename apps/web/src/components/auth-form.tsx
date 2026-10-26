"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { Me } from "@/lib/types";
import { Logo } from "./logo";
import { Button, Card, Input, Label } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    setLoading(true);
    try {
      await api(`/auth/${mode}`, {
        body: { email: form.get("email"), password: form.get("password"), ...(mode === "signup" ? { name: form.get("name") } : {}) },
      });
      qc.removeQueries();
      const me = await api<Me>("/me");
      const next = params.get("next");
      router.replace(me.memberships.length === 0 ? "/onboarding" : next?.startsWith("/app") ? next : "/app");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 inline-block">
          <Logo />
        </Link>
        <Card className="p-6">
          <h1 className="text-lg font-semibold tracking-tight">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
          <p className="mt-1 text-sm text-ink-3">{mode === "login" ? "Sign in to mission control." : "Start delegating work you can verify."}</p>
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {mode === "signup" && (
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required autoComplete="name" />
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div>
              <Label htmlFor="password" hint={mode === "signup" ? "10+ characters" : undefined}>
                Password
              </Label>
              <Input id="password" name="password" type="password" required minLength={mode === "signup" ? 10 : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </div>
            {error && (
              <p role="alert" className="rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-xs text-critical">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="w-full" loading={loading}>
              {mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-ink-3">
          {mode === "login" ? (
            <>
              New to ORBIX? <Link href="/signup" className="text-indigo hover:underline">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link href="/login" className="text-indigo hover:underline">Sign in</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
