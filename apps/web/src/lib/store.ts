"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiState {
  orgId: string | null;
  setOrgId: (id: string | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      orgId: null,
      setOrgId: (orgId) => set({ orgId }),
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    }),
    { name: "orbix-ui", partialize: (s) => ({ orgId: s.orgId }) },
  ),
);
