import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircle, MessagesSquare, Pencil, Trash2, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  buildChatReplyComment,
  chatReplyCommentMessageId,
  chatReplyCommentNumber,
  normalizeQuoteText,
  quoteTopOffset,
  useReplyCommentFocusStore,
} from "~/chatReplyComments";
import ChatMarkdown from "~/components/ChatMarkdown";
import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { useRightPanelStore } from "~/rightPanelStore";
import { quoteTextFromRange } from "~/selectionQuote";
import { useSideChatSelectionStore } from "~/sideChatSelectionStore";

const EMPTY_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];
let replyCommentSequence = 0;
const BUBBLE_CLASS_NAME =
  "flex size-6 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground shadow-sm transition-transform hover:scale-105";
/** Marks this component's own floating UI so document listeners ignore clicks inside it. */
const OWN_UI_ATTRIBUTE = "data-reply-comment-ui";
const OWN_UI_SELECTOR = `[${OWN_UI_ATTRIBUTE}]`;
/**
 * Marks every reply container that can own a selection. A selection belongs to
 * the container holding its focus node, so only one reply shows a toolbar even
 * when the highlight spans several replies.
 */
const SELECTION_ROOT_ATTRIBUTE = "data-reply-selection-root";
const SELECTION_ROOT_SELECTOR = `[${SELECTION_ROOT_ATTRIBUTE}]`;
/** Estimates used only for the frame before the floating element is measured. */
const TOOLBAR_WIDTH = 260;
const TOOLBAR_HEIGHT = 32;
const FORM_WIDTH = 288;
const FORM_HEIGHT = 150;
const VIEWPORT_MARGIN = 8;
/** Gap between the highlighted text and the floating element above it. */
const FLOATING_GAP = 6;

interface ReplySelection {
  readonly quote: string;
  /** The part of the document selection that lies inside this reply. */
  readonly range: Range;
}

interface FloatingPosition {
  readonly left: number;
  readonly top: number;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function isInsideOwnUi(target: EventTarget | null): boolean {
  return target instanceof Node && elementOf(target)?.closest(OWN_UI_SELECTOR) != null;
}

function selectionRootOf(node: Node | null): Element | null {
  return elementOf(node)?.closest(SELECTION_ROOT_SELECTOR) ?? null;
}

/**
 * Clips a document selection to one reply so a highlight that starts in the
 * previous message or ends in the next one still quotes the right text.
 */
function clipRangeToContainer(range: Range, container: HTMLElement): Range | null {
  const bounds = document.createRange();
  bounds.selectNodeContents(container);
  const clipped = range.cloneRange();
  try {
    if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
      clipped.setStart(bounds.startContainer, bounds.startOffset);
    }
    if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
      clipped.setEnd(bounds.endContainer, bounds.endOffset);
    }
  } catch {
    // Boundary points from another tree cannot be compared; treat as no overlap.
    return null;
  }
  return clipped.collapsed ? null : clipped;
}

/** Lets an unchanged selection skip a re-render when the watcher fires again. */
function sameRange(left: Range, right: Range): boolean {
  return (
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset
  );
}

/**
 * Places a floating element just above the first line of the highlight, like a
 * text-editing toolbar. Falls back to below the last line when there is no room
 * above, and returns null while the highlight is scrolled out of view.
 */
function floatingPosition(range: Range, width: number, height: number): FloatingPosition | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const first = rects[0] ?? range.getBoundingClientRect();
  if (first.width === 0 && first.height === 0) return null;
  if (first.bottom < 0 || first.top > window.innerHeight) return null;
  const last = rects[rects.length - 1] ?? first;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(first.left, VIEWPORT_MARGIN), maxLeft);
  const above = first.top - FLOATING_GAP - height;
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
  const top = above >= VIEWPORT_MARGIN ? above : Math.min(last.bottom + FLOATING_GAP, maxTop);
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * One document-level selection watcher shared by every mounted reply: the
 * listeners are attached once and each reply decides for itself whether the
 * current selection is its own.
 */
const selectionSubscribers = new Set<() => void>();
const SELECTION_DEBOUNCE_MS = 150;
/** Long enough for the browser to settle a double-click word selection. */
const POINTER_SETTLE_MS = 16;
let selectionPointerDown = false;
let selectionTimer: ReturnType<typeof setTimeout> | null = null;
let selectionWatcherAttached = false;

function scheduleSelectionNotify(delay: number) {
  if (selectionTimer !== null) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    selectionTimer = null;
    for (const subscriber of [...selectionSubscribers]) subscriber();
  }, delay);
}

function handleDocumentPointerDown() {
  selectionPointerDown = true;
}

function handleDocumentPointerUp() {
  selectionPointerDown = false;
  scheduleSelectionNotify(POINTER_SETTLE_MS);
}

function handleDocumentSelectionChange() {
  // A drag in progress reports intermediate selections; wait for mouseup.
  if (selectionPointerDown) return;
  scheduleSelectionNotify(SELECTION_DEBOUNCE_MS);
}

function subscribeToSelectionChanges(listener: () => void): () => void {
  selectionSubscribers.add(listener);
  if (!selectionWatcherAttached) {
    selectionWatcherAttached = true;
    document.addEventListener("mousedown", handleDocumentPointerDown, true);
    document.addEventListener("mouseup", handleDocumentPointerUp, true);
    document.addEventListener("selectionchange", handleDocumentSelectionChange);
  }
  return () => {
    selectionSubscribers.delete(listener);
    if (selectionSubscribers.size > 0 || !selectionWatcherAttached) return;
    selectionWatcherAttached = false;
    selectionPointerDown = false;
    if (selectionTimer !== null) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    document.removeEventListener("mousedown", handleDocumentPointerDown, true);
    document.removeEventListener("mouseup", handleDocumentPointerUp, true);
    document.removeEventListener("selectionchange", handleDocumentSelectionChange);
  };
}

/**
 * Lets the user highlight part of an assistant reply, attach a comment to the
 * composer or send the quote to the side chat, and see numbered bubbles beside
 * the reply for pending comments. Comments live in the composer draft as review
 * comments; nothing new crosses the wire.
 */
export function AssistantReplyComments(props: {
  readonly messageId: string;
  readonly threadRef: ScopedThreadRef;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly messageText: string;
  readonly origin?: "reply" | "side-chat";
}) {
  const { containerRef, messageId, threadRef } = props;
  const comments =
    useComposerDraftStore((store) => store.getComposerDraft(threadRef)?.reviewComments) ??
    EMPTY_COMMENTS;
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const setReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const ownComments = comments.filter(
    (comment) => chatReplyCommentMessageId(comment) === messageId,
  );

  const [selection, setSelection] = useState<ReplySelection | null>(null);
  const [composing, setComposing] = useState(false);
  const [floating, setFloating] = useState<FloatingPosition | null>(null);
  const [draftText, setDraftText] = useState("");
  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const [bubbleTops, setBubbleTops] = useState<ReadonlyMap<string, number>>(new Map());
  const [editText, setEditText] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  // Mirrors of the two pieces of state the document listeners read, so their
  // callbacks stay stable and never see a stale closure.
  const selectionRef = useRef<ReplySelection | null>(null);
  const composingRef = useRef(false);

  const applySelection = useCallback((next: ReplySelection | null) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);
  const applyComposing = useCallback((next: boolean) => {
    composingRef.current = next;
    setComposing(next);
  }, []);

  // A chip click in the composer opens the matching popover and scrolls it into view.
  const focusedCommentId = useReplyCommentFocusStore((store) => store.focusedCommentId);
  const clearFocusedComment = useReplyCommentFocusStore((store) => store.clear);
  useEffect(() => {
    if (!focusedCommentId || !ownComments.some((comment) => comment.id === focusedCommentId)) {
      return;
    }
    setOpenCommentId(focusedCommentId);
    setEditText(null);
    clearFocusedComment(focusedCommentId);
    containerRef.current
      ?.querySelector(`[data-reply-comment-id="${focusedCommentId}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the focused id changes
  }, [focusedCommentId]);

  const closeForm = useCallback(() => {
    applyComposing(false);
    applySelection(null);
    setDraftText("");
  }, [applyComposing, applySelection]);

  const evaluateSelection = useCallback(() => {
    // The open form owns the quote; the caret has moved into its textarea.
    if (composingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const clear = () => {
      if (selectionRef.current) applySelection(null);
    };
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
      clear();
      return;
    }
    const { anchorNode, focusNode } = domSelection;
    if (isInsideOwnUi(focusNode) || isInsideOwnUi(anchorNode)) return;
    // The reply holding the end of the selection wins; a selection dragged past
    // the last reply keeps its start's owner.
    const owner = selectionRootOf(focusNode) ?? selectionRootOf(anchorNode);
    if (owner !== container) {
      clear();
      return;
    }
    const range = clipRangeToContainer(domSelection.getRangeAt(0), container);
    const quote = range ? normalizeQuoteText(quoteTextFromRange(range)) : "";
    if (!range || quote.length === 0) {
      clear();
      return;
    }
    const previous = selectionRef.current;
    if (previous && previous.quote === quote && sameRange(previous.range, range)) return;
    setDraftText("");
    applySelection({ quote, range });
  }, [applySelection, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.setAttribute(SELECTION_ROOT_ATTRIBUTE, "");
    const unsubscribe = subscribeToSelectionChanges(evaluateSelection);
    return () => {
      unsubscribe();
      container.removeAttribute(SELECTION_ROOT_ATTRIBUTE);
    };
  }, [containerRef, evaluateSelection]);

  // Floating UI is portalled to the body, so viewport coordinates hold even
  // inside transformed or contained ancestors such as the resizable panels.
  const updateFloatingPosition = useCallback(() => {
    const current = selectionRef.current;
    if (!current) {
      setFloating(null);
      return;
    }
    const element = composingRef.current ? formRef.current : toolbarRef.current;
    const width = element?.offsetWidth || (composingRef.current ? FORM_WIDTH : TOOLBAR_WIDTH);
    const height = element?.offsetHeight || (composingRef.current ? FORM_HEIGHT : TOOLBAR_HEIGHT);
    const next = floatingPosition(current.range, width, height);
    setFloating((previous) => {
      if (previous === next) return previous;
      if (previous && next && previous.left === next.left && previous.top === next.top) {
        return previous;
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    updateFloatingPosition();
  }, [composing, selection, updateFloatingPosition]);

  useEffect(() => {
    if (!selection) return;
    const handle = () => updateFloatingPosition();
    // Capture phase: the reply scrolls inside a nested scroller, not the window.
    document.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      document.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [selection, updateFloatingPosition]);

  // Clicking anywhere outside the form abandons it.
  useEffect(() => {
    if (!composing) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!isInsideOwnUi(event.target)) closeForm();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [closeForm, composing]);

  // Place each bubble beside the first line of its quote; stack unmatched ones at the top.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || ownComments.length === 0) {
      setBubbleTops((previous) => (previous.size === 0 ? previous : new Map()));
      return;
    }
    const measure = () => {
      const next = new Map<string, number>();
      let fallbackTop = 0;
      for (const comment of ownComments) {
        const top = quoteTopOffset(container, comment.diff);
        if (top === null) {
          next.set(comment.id, fallbackTop);
          fallbackTop += 28;
        } else {
          next.set(comment.id, Math.max(0, top));
        }
      }
      setBubbleTops(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure when the comment set or text changes
  }, [containerRef, ownComments.map((comment) => comment.id).join("|"), props.messageText]);

  const submit = useCallback(() => {
    if (!selection) return;
    const text = draftText.trim();
    if (text.length === 0) return;
    addReviewComment(
      threadRef,
      buildChatReplyComment({
        id: `reply-comment-${Date.now().toString(36)}-${(replyCommentSequence += 1)}`,
        messageId,
        quote: selection.quote,
        text,
        existing: comments,
        ...(props.origin ? { origin: props.origin } : {}),
      }),
    );
    window.getSelection()?.removeAllRanges();
    closeForm();
  }, [
    addReviewComment,
    closeForm,
    comments,
    draftText,
    messageId,
    props.origin,
    selection,
    threadRef,
  ]);

  const askInSideChat = useCallback(() => {
    if (!selection) return;
    useSideChatSelectionStore.getState().add(threadRef, {
      quote: selection.quote,
      source: props.origin === "side-chat" ? "side-chat" : "reply",
    });
    useRightPanelStore.getState().open(threadRef, "side-chat");
    window.getSelection()?.removeAllRanges();
    closeForm();
  }, [closeForm, props.origin, selection, threadRef]);

  const handleFormKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeForm();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const openComment = ownComments.find((comment) => comment.id === openCommentId) ?? null;
  const saveEdit = () => {
    const text = editText?.trim() ?? "";
    if (!openComment || text.length === 0) return;
    setReviewComments(
      threadRef,
      comments.map((comment) => (comment.id === openComment.id ? { ...comment, text } : comment)),
    );
    setEditText(null);
  };
  const floatingStyle = { left: floating?.left ?? 0, top: floating?.top ?? 0 };

  return (
    <>
      {ownComments.map((comment) => {
        const top = bubbleTops.get(comment.id) ?? 0;
        const number = chatReplyCommentNumber(comment);
        return (
          <button
            key={comment.id}
            type="button"
            aria-label={`Comment ${number}`}
            {...{ [OWN_UI_ATTRIBUTE]: "" }}
            data-reply-comment-id={comment.id}
            className={cn(BUBBLE_CLASS_NAME, "absolute right-1 z-10")}
            style={{ top }}
            onClick={(event) => {
              event.stopPropagation();
              setEditText(null);
              setOpenCommentId((current) => (current === comment.id ? null : comment.id));
            }}
          >
            {number}
          </button>
        );
      })}
      {openComment ? (
        <div
          {...{ [OWN_UI_ATTRIBUTE]: "" }}
          className="absolute right-0 z-20 w-72 max-w-full space-y-2 rounded-lg border border-border bg-popover p-3 text-xs shadow-lg"
          style={{ top: (bubbleTops.get(openComment.id) ?? 0) + 28 }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{openComment.rangeLabel}</span>
            <button
              type="button"
              aria-label="Close"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => setOpenCommentId(null)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <blockquote className="line-clamp-4 border-s-2 border-border ps-2 text-muted-foreground">
            <ChatMarkdown text={openComment.diff} cwd={undefined} threadRef={threadRef} />
          </blockquote>
          {editText === null ? (
            <div className="whitespace-pre-wrap">{openComment.text}</div>
          ) : (
            <textarea
              autoFocus
              rows={3}
              value={editText}
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-ring"
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditText(null);
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  saveEdit();
                }
              }}
            />
          )}
          <div className="flex justify-end gap-1.5">
            {editText === null ? (
              <>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                  onClick={() => setEditText(openComment.text)}
                >
                  <Pencil className="size-3.5" aria-hidden />
                  Edit
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    removeReviewComment(threadRef, openComment.id);
                    setOpenCommentId(null);
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Delete
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditText(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={editText.trim().length === 0}
                  className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-50"
                  onClick={saveEdit}
                >
                  Save
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {selection && !composing
        ? createPortal(
            <div
              ref={toolbarRef}
              {...{ [OWN_UI_ATTRIBUTE]: "" }}
              className={cn(
                "fixed z-50 flex items-center gap-0.5 rounded-full border border-border bg-popover p-0.5 text-popover-foreground shadow-md",
                floating ? null : "invisible",
              )}
              style={floatingStyle}
              onMouseDown={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-muted"
                onClick={() => applyComposing(true)}
              >
                <MessageCircle className="size-3.5" aria-hidden />
                Add to chat
              </button>
              <span aria-hidden className="h-4 w-px bg-border" />
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-muted"
                onClick={askInSideChat}
              >
                <MessagesSquare className="size-3.5" aria-hidden />
                Ask in side chat
              </button>
            </div>,
            document.body,
          )
        : null}
      {selection && composing
        ? createPortal(
            <div
              ref={formRef}
              {...{ [OWN_UI_ATTRIBUTE]: "" }}
              className={cn(
                "fixed z-50 w-72 space-y-2 rounded-lg border border-border bg-popover p-2 shadow-lg",
                floating ? null : "invisible",
              )}
              style={floatingStyle}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <blockquote className="line-clamp-2 border-s-2 border-border ps-2 text-[11px] text-muted-foreground">
                <ChatMarkdown text={selection.quote} cwd={undefined} threadRef={threadRef} />
              </blockquote>
              <textarea
                autoFocus
                rows={2}
                value={draftText}
                placeholder="Your comment"
                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-ring"
                onChange={(event) => setDraftText(event.target.value)}
                onKeyDown={handleFormKeyDown}
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={closeForm}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={draftText.trim().length === 0}
                  className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  onClick={submit}
                >
                  Send
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
