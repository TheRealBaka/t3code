import { create } from "zustand";

import type { ReviewCommentContext } from "./reviewCommentContext";
import { quoteSearchNeedle } from "./selectionQuote";

/**
 * Comments on assistant replies reuse the review-comment record so the
 * composer chip, prompt serialization, and sent-message card come for free.
 * The section id carries the message id; the range label carries the number.
 */
const CHAT_REPLY_COMMENT_SECTION_PREFIX = "assistant-reply:";
export const CHAT_REPLY_COMMENT_FILE_PATH = "Assistant reply";
const CHAT_REPLY_COMMENT_SECTION_TITLE = "Comment on assistant reply";

export function isChatReplyComment(comment: ReviewCommentContext): boolean {
  return comment.sectionId.startsWith(CHAT_REPLY_COMMENT_SECTION_PREFIX);
}

export function chatReplyCommentMessageId(comment: ReviewCommentContext): string | null {
  return isChatReplyComment(comment)
    ? comment.sectionId.slice(CHAT_REPLY_COMMENT_SECTION_PREFIX.length)
    : null;
}

function commentLabel(number: number): string {
  return `Comment ${number}`;
}

/** The number shown in the bubble and chip, taken from the stored label. */
export function chatReplyCommentNumber(comment: ReviewCommentContext): number {
  const match = /(\d+)\s*$/.exec(comment.rangeLabel);
  return match ? Number(match[1]) : 0;
}

export function buildChatReplyComment(input: {
  readonly id: string;
  readonly messageId: string;
  readonly quote: string;
  readonly text: string;
  readonly existing: ReadonlyArray<ReviewCommentContext>;
  /** Side chat answers are labelled so the agent knows the quote is not from the main thread. */
  readonly origin?: "reply" | "side-chat";
}): ReviewCommentContext {
  const number = input.existing.filter(isChatReplyComment).length + 1;
  const sideChat = input.origin === "side-chat";
  return {
    id: input.id,
    sectionId: `${CHAT_REPLY_COMMENT_SECTION_PREFIX}${input.messageId}`,
    sectionTitle: sideChat ? "Comment on side chat answer" : CHAT_REPLY_COMMENT_SECTION_TITLE,
    filePath: sideChat ? "Side chat answer" : CHAT_REPLY_COMMENT_FILE_PATH,
    startIndex: 0,
    endIndex: 0,
    rangeLabel: commentLabel(number),
    text: input.text.trim(),
    diff: input.quote,
    fenceLanguage: "text",
  };
}

/** Keeps reply comments numbered 1..n after one is removed. */
export function renumberChatReplyComments(
  comments: ReadonlyArray<ReviewCommentContext>,
): ReviewCommentContext[] {
  let next = 1;
  return comments.map((comment) => {
    if (!isChatReplyComment(comment)) return comment;
    const rangeLabel = commentLabel(next);
    next += 1;
    return comment.rangeLabel === rangeLabel ? comment : { ...comment, rangeLabel };
  });
}

/** Whitespace-insensitive search for the quoted text; used to place bubbles. */
export function normalizeQuoteText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface TextPosition {
  /** Index into the searched texts. */
  readonly index: number;
  readonly offset: number;
}

/**
 * Whitespace-insensitive search for a quote's searchable part across a run of
 * text nodes' contents. Returns where it starts and ends, or null when the
 * text is not there.
 */
export function locateQuote(
  texts: ReadonlyArray<string>,
  quote: string,
): { readonly start: TextPosition; readonly end: TextPosition } | null {
  const needle = normalizeQuoteText(quoteSearchNeedle(quote));
  if (needle.length === 0) return null;
  const starts: number[] = [];
  let haystack = "";
  for (const text of texts) {
    starts.push(haystack.length);
    haystack += text;
  }
  const normalized = haystack.replace(/\s+/g, " ");
  // Map indexes in the collapsed string back to the raw string.
  const rawIndexByNormalized: number[] = [];
  let previousWasSpace = false;
  for (let index = 0; index < haystack.length; index += 1) {
    const isSpace = /\s/.test(haystack[index] ?? "");
    if (isSpace && previousWasSpace) continue;
    rawIndexByNormalized.push(index);
    previousWasSpace = isSpace;
  }
  const foundAt = normalized.indexOf(needle);
  if (foundAt < 0) return null;
  const rawStart = rawIndexByNormalized[foundAt];
  const rawLast = rawIndexByNormalized[foundAt + needle.length - 1];
  if (rawStart === undefined || rawLast === undefined) return null;
  // The last text starting at or before a character holds it.
  const indexOf = (rawIndex: number) => starts.findLastIndex((start) => start <= rawIndex);
  const startIndex = indexOf(rawStart);
  const endIndex = indexOf(rawLast);
  if (startIndex < 0 || endIndex < 0) return null;
  return {
    start: { index: startIndex, offset: rawStart - (starts[startIndex] ?? 0) },
    end: { index: endIndex, offset: rawLast - (starts[endIndex] ?? 0) + 1 },
  };
}

/** Finds the rendered quote inside a container, or null when the text is no longer present. */
export function findQuoteRange(container: HTMLElement, quote: string): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const location = locateQuote(
    nodes.map((node) => node.data),
    quote,
  );
  const startNode = location ? nodes[location.start.index] : undefined;
  const endNode = location ? nodes[location.end.index] : undefined;
  if (!location || !startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, location.start.offset);
  range.setEnd(endNode, location.end.offset);
  return range;
}

/**
 * Finds the rendered quote inside a container and returns its top offset
 * relative to the container, or null when the text is no longer present.
 */
export function quoteTopOffset(container: HTMLElement, quote: string): number | null {
  const range = findQuoteRange(container, quote);
  if (!range) return null;
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return rect.top - containerRect.top;
}

/** The reply comment being written: its quote and the text typed so far. */
export interface ReplyCommentDraft {
  readonly messageId: string;
  readonly quote: string;
  readonly text: string;
}

/**
 * The open comment form's draft, held outside the reply so a remount of the
 * reply (a virtualized row scrolling back in, a folded turn expanding again)
 * reopens the form instead of dropping the text. Only one form is open at a
 * time, so one slot is enough; closing the form clears it.
 */
let pendingReplyCommentDraft: ReplyCommentDraft | null = null;

export function readReplyCommentDraft(): ReplyCommentDraft | null {
  return pendingReplyCommentDraft;
}

export function saveReplyCommentDraft(draft: ReplyCommentDraft): void {
  pendingReplyCommentDraft = draft;
}

/** Clears the draft only if it belongs to this reply; another reply's draft stays. */
export function clearReplyCommentDraft(messageId: string): void {
  if (pendingReplyCommentDraft?.messageId === messageId) {
    pendingReplyCommentDraft = null;
  }
}

/** Chip-to-reply signal: the composer asks the reply that owns a comment to open it. */
export const useReplyCommentFocusStore = create<{
  readonly focusedCommentId: string | null;
  readonly focus: (commentId: string) => void;
  readonly clear: (commentId: string) => void;
}>((set) => ({
  focusedCommentId: null,
  focus: (commentId) => set({ focusedCommentId: commentId }),
  clear: (commentId) =>
    set((state) => (state.focusedCommentId === commentId ? { focusedCommentId: null } : state)),
}));
