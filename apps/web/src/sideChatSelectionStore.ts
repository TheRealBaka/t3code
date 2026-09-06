import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Text the user highlighted in a reply and sent to the side chat with
 * "Ask in side chat". Shown as selection chips above the side chat composer
 * and quoted ahead of the next side question. Memory only, per thread.
 */
export interface SideChatSelection {
  readonly id: string;
  readonly quote: string;
  /** Where the text came from, for the chip tooltip and the quote label. */
  readonly source: "reply" | "side-chat";
}

interface SideChatSelectionStoreState {
  readonly byThreadKey: Readonly<Record<string, ReadonlyArray<SideChatSelection>>>;
  readonly add: (ref: ScopedThreadRef, selection: Omit<SideChatSelection, "id">) => string;
  readonly remove: (ref: ScopedThreadRef, selectionId: string) => void;
  readonly clear: (ref: ScopedThreadRef) => void;
}

const EMPTY_SELECTIONS: ReadonlyArray<SideChatSelection> = [];
let selectionSequence = 0;

export function selectSideChatSelections(
  state: Pick<SideChatSelectionStoreState, "byThreadKey">,
  ref: ScopedThreadRef,
): ReadonlyArray<SideChatSelection> {
  return state.byThreadKey[scopedThreadKey(ref)] ?? EMPTY_SELECTIONS;
}

/** Quotes the selections as a markdown block to put ahead of a side question. */
export function formatSideChatSelectionsForPrompt(
  selections: ReadonlyArray<SideChatSelection>,
): string {
  if (selections.length === 0) return "";
  return selections
    .map((selection, index) => {
      const label =
        selection.source === "side-chat" ? "earlier side chat answer" : "the assistant's reply";
      const quoted = selection.quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `Selection ${index + 1} (from ${label}):\n${quoted}`;
    })
    .join("\n\n");
}

export const useSideChatSelectionStore = create<SideChatSelectionStoreState>((set) => ({
  byThreadKey: {},
  add: (ref, selection) => {
    selectionSequence += 1;
    const id = `side-selection-${Date.now().toString(36)}-${selectionSequence}`;
    const threadKey = scopedThreadKey(ref);
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: [...(state.byThreadKey[threadKey] ?? EMPTY_SELECTIONS), { ...selection, id }],
      },
    }));
    return id;
  },
  remove: (ref, selectionId) => {
    const threadKey = scopedThreadKey(ref);
    set((state) => {
      const current = state.byThreadKey[threadKey];
      if (!current) return state;
      const next = current.filter((selection) => selection.id !== selectionId);
      return { byThreadKey: { ...state.byThreadKey, [threadKey]: next } };
    });
  },
  clear: (ref) => {
    const threadKey = scopedThreadKey(ref);
    set((state) => {
      if (!(threadKey in state.byThreadKey)) return state;
      const next = { ...state.byThreadKey };
      delete next[threadKey];
      return { byThreadKey: next };
    });
  },
}));
