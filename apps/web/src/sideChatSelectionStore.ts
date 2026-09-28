import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { renumberChatReplyComments } from "./chatReplyComments";
import type { ReviewCommentContext } from "./reviewCommentContext";

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

/**
 * Comments the user left on side chat answers. They use the same record as
 * comments on main replies, so the reply shows the same numbered bubbles, but
 * they travel with the next side question instead of the next main message.
 */
interface SideChatSelectionStoreState {
  readonly byThreadKey: Readonly<Record<string, ReadonlyArray<SideChatSelection>>>;
  readonly commentsByThreadKey: Readonly<Record<string, ReadonlyArray<ReviewCommentContext>>>;
  readonly add: (ref: ScopedThreadRef, selection: Omit<SideChatSelection, "id">) => string;
  readonly remove: (ref: ScopedThreadRef, selectionId: string) => void;
  readonly addComment: (ref: ScopedThreadRef, comment: ReviewCommentContext) => void;
  readonly setComments: (
    ref: ScopedThreadRef,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void;
  readonly removeComment: (ref: ScopedThreadRef, commentId: string) => void;
  /** Drops the thread's selections and comments, after a send or when the side chat ends. */
  readonly clear: (ref: ScopedThreadRef) => void;
}

const EMPTY_SELECTIONS: ReadonlyArray<SideChatSelection> = [];
const EMPTY_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];
let selectionSequence = 0;

export function selectSideChatSelections(
  state: Pick<SideChatSelectionStoreState, "byThreadKey">,
  ref: ScopedThreadRef,
): ReadonlyArray<SideChatSelection> {
  return state.byThreadKey[scopedThreadKey(ref)] ?? EMPTY_SELECTIONS;
}

export function selectSideChatComments(
  state: Pick<SideChatSelectionStoreState, "commentsByThreadKey">,
  ref: ScopedThreadRef,
): ReadonlyArray<ReviewCommentContext> {
  return state.commentsByThreadKey[scopedThreadKey(ref)] ?? EMPTY_COMMENTS;
}

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Quotes the selections and comments as markdown to put ahead of a side question. */
export function formatSideChatSelectionsForPrompt(
  selections: ReadonlyArray<SideChatSelection>,
  comments: ReadonlyArray<ReviewCommentContext> = EMPTY_COMMENTS,
): string {
  const selectionBlocks = selections.map((selection, index) => {
    const label =
      selection.source === "side-chat" ? "earlier side chat answer" : "the assistant's reply";
    return `Selection ${index + 1} (from ${label}):\n${quoteLines(selection.quote)}`;
  });
  const commentBlocks = comments.map(
    (comment) =>
      `${comment.rangeLabel} (on an earlier side chat answer):\n${quoteLines(comment.diff)}\n\n${comment.text}`,
  );
  return [...selectionBlocks, ...commentBlocks].join("\n\n");
}

function updateComments(
  state: SideChatSelectionStoreState,
  ref: ScopedThreadRef,
  next: (current: ReadonlyArray<ReviewCommentContext>) => ReadonlyArray<ReviewCommentContext>,
): Pick<SideChatSelectionStoreState, "commentsByThreadKey"> {
  const threadKey = scopedThreadKey(ref);
  return {
    commentsByThreadKey: {
      ...state.commentsByThreadKey,
      [threadKey]: next(state.commentsByThreadKey[threadKey] ?? EMPTY_COMMENTS),
    },
  };
}

export const useSideChatSelectionStore = create<SideChatSelectionStoreState>((set) => ({
  byThreadKey: {},
  commentsByThreadKey: {},
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
  addComment: (ref, comment) =>
    set((state) =>
      updateComments(state, ref, (current) => [
        ...current.filter((entry) => entry.id !== comment.id),
        comment,
      ]),
    ),
  setComments: (ref, comments) => set((state) => updateComments(state, ref, () => comments)),
  removeComment: (ref, commentId) =>
    set((state) =>
      updateComments(state, ref, (current) =>
        renumberChatReplyComments(current.filter((entry) => entry.id !== commentId)),
      ),
    ),
  clear: (ref) => {
    const threadKey = scopedThreadKey(ref);
    set((state) => {
      if (!(threadKey in state.byThreadKey) && !(threadKey in state.commentsByThreadKey)) {
        return state;
      }
      const byThreadKey = { ...state.byThreadKey };
      const commentsByThreadKey = { ...state.commentsByThreadKey };
      delete byThreadKey[threadKey];
      delete commentsByThreadKey[threadKey];
      return { byThreadKey, commentsByThreadKey };
    });
  },
}));
