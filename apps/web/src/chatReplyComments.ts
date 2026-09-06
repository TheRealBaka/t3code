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

/**
 * Finds the rendered quote inside a container and returns its top offset
 * relative to the container, or null when the text is no longer present.
 */
export function quoteTopOffset(container: HTMLElement, quote: string): number | null {
  const needle = normalizeQuoteText(quoteSearchNeedle(quote));
  if (needle.length === 0) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number }> = [];
  let haystack = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push({ node: text, start: haystack.length });
    haystack += text.data;
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
  const rawIndex = rawIndexByNormalized[foundAt];
  if (rawIndex === undefined) return null;
  const entry = [...nodes].reverse().find((candidate) => candidate.start <= rawIndex);
  if (!entry) return null;
  const range = document.createRange();
  const offset = Math.min(rawIndex - entry.start, entry.node.data.length);
  range.setStart(entry.node, offset);
  range.setEnd(entry.node, offset);
  const rect = range.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return rect.top - containerRect.top;
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
