import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { buildChatReplyComment } from "./chatReplyComments";
import type { ReviewCommentContext } from "./reviewCommentContext";
import {
  formatSideChatSelectionsForPrompt,
  selectSideChatComments,
  selectSideChatSelections,
  useSideChatSelectionStore,
} from "./sideChatSelectionStore";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-local"), ThreadId.make("thread"));

function sideChatComment(
  id: string,
  quote: string,
  text: string,
  existing: ReadonlyArray<ReviewCommentContext>,
): ReviewCommentContext {
  return buildChatReplyComment({
    id,
    messageId: "side-chat:exchange-1",
    quote,
    text,
    existing,
    origin: "side-chat",
  });
}

describe("side chat comments", () => {
  beforeEach(() => {
    useSideChatSelectionStore.getState().clear(threadRef);
  });

  it("quotes each comment with its note for the next side question", () => {
    const comment = sideChatComment("c1", "line one\nline two", "Why this order?", []);
    const prompt = formatSideChatSelectionsForPrompt([], [comment]);
    expect(prompt).toBe(
      "Comment 1 (on an earlier side chat answer):\n> line one\n> line two\n\nWhy this order?",
    );
  });

  it("renumbers the remaining comments after one is removed", () => {
    const store = useSideChatSelectionStore.getState();
    const first = sideChatComment("c1", "alpha", "first note", []);
    store.addComment(threadRef, first);
    const second = sideChatComment("c2", "beta", "second note", [first]);
    store.addComment(threadRef, second);

    store.removeComment(threadRef, "c1");

    const remaining = selectSideChatComments(useSideChatSelectionStore.getState(), threadRef);
    expect(remaining.map((comment) => [comment.id, comment.rangeLabel])).toEqual([
      ["c2", "Comment 1"],
    ]);
  });

  it("clearing drops both the selections and the comments", () => {
    const store = useSideChatSelectionStore.getState();
    store.add(threadRef, { quote: "picked text", source: "reply" });
    store.addComment(threadRef, sideChatComment("c1", "alpha", "note", []));

    store.clear(threadRef);

    const state = useSideChatSelectionStore.getState();
    expect(selectSideChatSelections(state, threadRef)).toEqual([]);
    expect(selectSideChatComments(state, threadRef)).toEqual([]);
  });
});
