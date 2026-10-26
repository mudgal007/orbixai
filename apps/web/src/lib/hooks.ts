"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api";
import { useUi } from "./store";
import type { Me } from "./types";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), staleTime: 60_000, retry: false });
}

/** Current organization: the persisted selection if the user still belongs to it, else the first membership. */
export function useOrg() {
  const me = useMe();
  const { orgId, setOrgId } = useUi();
  const memberships = me.data?.memberships ?? [];
  const current = memberships.find((m) => m.organization.id === orgId) ?? memberships[0];
  useEffect(() => {
    if (current && current.organization.id !== orgId) setOrgId(current.organization.id);
  }, [current, orgId, setOrgId]);
  return {
    me,
    orgId: current?.organization.id ?? null,
    org: current?.organization,
    role: current?.role,
    can: (permission: string) => !!current?.permissions.includes(permission),
  };
}
