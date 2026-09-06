/**
 * Which environment and provider the usage card is showing, if it is open.
 *
 * Deliberately not persisted and not thread-scoped: the card reports an
 * account's plan quota and a machine's token totals, both of which outlive any
 * one thread. Reopening it re-reads.
 */
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { create } from "zustand";

export interface UsageCardTarget {
  readonly environmentId: EnvironmentId;
  /** The provider the composer would send to, so the card can say what it covers. */
  readonly provider: ProviderDriverKind;
}

interface UsageCardState {
  readonly target: UsageCardTarget | null;
  readonly open: (target: UsageCardTarget) => void;
  readonly close: () => void;
}

export const useUsageCardStore = create<UsageCardState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/**
 * `/usage` (and its `/status` alias) opens the card instead of sending to the
 * agent. Only a bare command counts: a prompt that goes on to say something is
 * a message about usage, not a request to see it.
 */
export function isUsageComposerCommand(text: string): boolean {
  return /^\/(usage|status)$/i.test(text.trim());
}
