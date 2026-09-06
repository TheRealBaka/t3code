/**
 * Side chats: ephemeral forks of a thread's provider conversation, in the
 * spirit of Claude Code's `/btw`. The server keeps them in memory only, so
 * this store is deliberately not persisted — a reload starts a fresh fork.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export type SideChatExchangeStatus = "streaming" | "done" | "error";

export interface SideChatExchange {
  readonly id: string;
  readonly prompt: string;
  readonly answer: string;
  readonly status: SideChatExchangeStatus;
  readonly error?: string;
  /** The thread's provider cannot fork conversations; the panel says so loudly. */
  readonly unsupportedProvider?: boolean;
}

/**
 * The fork's own context window, reported by the server after each answer.
 * `maxTokens` is null when neither the SDK nor the model catalog knows the
 * window size, which the meter renders as a bare token count.
 */
export interface SideChatUsage {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  /** When the reading landed, so the meter has a stable snapshot identity. */
  readonly updatedAt: string;
}

/** A `/btw` prompt handed over by the composer, asked once the panel mounts. */
export interface SideChatPendingAsk {
  readonly id: string;
  readonly prompt: string;
}

export interface SideChatThreadState {
  readonly sideChatId: string;
  readonly exchanges: readonly SideChatExchange[];
  readonly pendingAsk: SideChatPendingAsk | null;
  /**
   * The reader's own model/effort pick for this thread's side chat. Null means
   * "follow the thread", which is also what the server does when the ask omits
   * a selection. Deliberately not persisted, like the fork itself.
   */
  readonly modelSelection: ModelSelection | null;
  /** Latest context window reading for this thread's fork; null before the first answer. */
  readonly usage: SideChatUsage | null;
}

interface SideChatStoreState {
  byThreadKey: Record<string, SideChatThreadState>;
  /** The thread's side chat id, minting one on first use. */
  ensureSideChat: (ref: ScopedThreadRef) => string;
  /** Records a question as streaming and returns its exchange id. */
  appendExchange: (ref: ScopedThreadRef, prompt: string) => string;
  appendAnswer: (ref: ScopedThreadRef, exchangeId: string, text: string) => void;
  completeExchange: (ref: ScopedThreadRef, exchangeId: string, text: string) => void;
  /** Keeps whatever streamed in; used when the reader interrupts the answer. */
  settleExchange: (ref: ScopedThreadRef, exchangeId: string) => void;
  failExchange: (
    ref: ScopedThreadRef,
    exchangeId: string,
    failure: { readonly error: string; readonly unsupportedProvider: boolean },
  ) => void;
  /** Forgets the transcript and forks again from the thread's current state. */
  reset: (ref: ScopedThreadRef) => void;
  requestAsk: (ref: ScopedThreadRef, prompt: string) => void;
  clearPendingAsk: (ref: ScopedThreadRef) => void;
  /** Overrides the model and effort the next question runs with. */
  setModelSelection: (ref: ScopedThreadRef, selection: ModelSelection) => void;
  /** Records the fork's context window as reported by the server. */
  setUsage: (ref: ScopedThreadRef, usage: Omit<SideChatUsage, "updatedAt">) => void;
}

// A counter beside the clock, because crypto.randomUUID is not available on
// every surface this bundle runs in.
let idCounter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

const EMPTY_THREAD_STATE: SideChatThreadState = {
  sideChatId: "",
  exchanges: [],
  pendingAsk: null,
  modelSelection: null,
  usage: null,
};

function newThreadState(): SideChatThreadState {
  return {
    sideChatId: nextId("side-chat"),
    exchanges: [],
    pendingAsk: null,
    modelSelection: null,
    usage: null,
  };
}

function updateThread(
  byThreadKey: Record<string, SideChatThreadState>,
  ref: ScopedThreadRef,
  updater: (current: SideChatThreadState) => SideChatThreadState,
): Record<string, SideChatThreadState> {
  const threadKey = scopedThreadKey(ref);
  // A no-op updater on a thread with no state leaves the map alone: the
  // placeholder it was handed is thrown away rather than minting a fork id.
  const current = byThreadKey[threadKey] ?? newThreadState();
  const next = updater(current);
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
}

function updateExchange(
  current: SideChatThreadState,
  exchangeId: string,
  updater: (exchange: SideChatExchange) => SideChatExchange,
): SideChatThreadState {
  const found = current.exchanges.some((exchange) => exchange.id === exchangeId);
  if (!found) return current;
  return {
    ...current,
    exchanges: current.exchanges.map((exchange) =>
      exchange.id === exchangeId ? updater(exchange) : exchange,
    ),
  };
}

export const useSideChatStore = create<SideChatStoreState>()((set, get) => ({
  byThreadKey: {},
  ensureSideChat: (ref) => {
    const threadKey = scopedThreadKey(ref);
    const existing = get().byThreadKey[threadKey];
    if (existing) return existing.sideChatId;
    const created = newThreadState();
    set((state) =>
      state.byThreadKey[threadKey]
        ? state
        : { byThreadKey: { ...state.byThreadKey, [threadKey]: created } },
    );
    return get().byThreadKey[threadKey]?.sideChatId ?? created.sideChatId;
  },
  appendExchange: (ref, prompt) => {
    const exchangeId = nextId("exchange");
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
        ...current,
        exchanges: [
          ...current.exchanges,
          { id: exchangeId, prompt, answer: "", status: "streaming" as const },
        ],
      })),
    }));
    return exchangeId;
  },
  appendAnswer: (ref, exchangeId, text) => {
    if (text.length === 0) return;
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
        updateExchange(current, exchangeId, (exchange) => ({
          ...exchange,
          answer: exchange.answer + text,
        })),
      ),
    }));
  },
  completeExchange: (ref, exchangeId, text) => {
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
        updateExchange(current, exchangeId, (exchange) => ({
          ...exchange,
          // The final event carries the whole answer; the deltas were a preview.
          answer: text.length > 0 ? text : exchange.answer,
          status: "done" as const,
        })),
      ),
    }));
  },
  settleExchange: (ref, exchangeId) => {
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
        updateExchange(current, exchangeId, (exchange) =>
          exchange.status === "streaming" ? { ...exchange, status: "done" as const } : exchange,
        ),
      ),
    }));
  },
  failExchange: (ref, exchangeId, failure) => {
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
        updateExchange(current, exchangeId, (exchange) => ({
          ...exchange,
          status: "error" as const,
          error: failure.error,
          ...(failure.unsupportedProvider ? { unsupportedProvider: true } : {}),
        })),
      ),
    }));
  },
  reset: (ref) => {
    set((state) => ({
      // Clearing starts the transcript over, not the composer's setup: the
      // model pick survives so the next question runs where the last one did.
      byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
        ...newThreadState(),
        modelSelection: current.modelSelection,
      })),
    }));
  },
  requestAsk: (ref, prompt) => {
    const pendingAsk = { id: nextId("ask"), prompt };
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
        ...current,
        pendingAsk,
      })),
    }));
  },
  clearPendingAsk: (ref) => {
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
        current.pendingAsk === null ? current : { ...current, pendingAsk: null },
      ),
    }));
  },
  setModelSelection: (ref, selection) => {
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
        ...current,
        modelSelection: selection,
      })),
    }));
  },
  setUsage: (ref, usage) => {
    set((state) => ({
      byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
        current.usage?.usedTokens === usage.usedTokens &&
        current.usage.maxTokens === usage.maxTokens
          ? current
          : { ...current, usage: { ...usage, updatedAt: new Date().toISOString() } },
      ),
    }));
  },
}));

export function selectSideChatThreadState(
  byThreadKey: Record<string, SideChatThreadState>,
  ref: ScopedThreadRef | null | undefined,
): SideChatThreadState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}
