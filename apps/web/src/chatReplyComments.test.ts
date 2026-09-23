import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearReplyCommentDraft,
  locateQuote,
  readReplyCommentDraft,
  saveReplyCommentDraft,
} from "./chatReplyComments";

describe("locateQuote", () => {
  it("finds a quote inside one text", () => {
    expect(locateQuote(["The loss converges quickly."], "loss converges")).toEqual({
      start: { index: 0, offset: 4 },
      end: { index: 0, offset: 18 },
    });
  });

  it("follows a quote across texts split by inline markup", () => {
    // "Use the " + <code>parse</code> + " helper here"
    expect(locateQuote(["Use the ", "parse", " helper here"], "the parse helper")).toEqual({
      start: { index: 0, offset: 4 },
      end: { index: 2, offset: 7 },
    });
  });

  it("matches across differing whitespace and line breaks", () => {
    expect(locateQuote(["first line\n\n", "  second line"], "line second")).toEqual({
      start: { index: 0, offset: 6 },
      end: { index: 1, offset: 8 },
    });
  });

  it("skips empty texts at a boundary", () => {
    expect(locateQuote(["ab", "", "cd"], "cd")).toEqual({
      start: { index: 2, offset: 0 },
      end: { index: 2, offset: 2 },
    });
  });

  it("searches by the text ahead of the first formula", () => {
    expect(locateQuote(["so that ", "E=mc2", " holds"], "so that $E = mc^2$ holds")).toEqual({
      start: { index: 0, offset: 0 },
      end: { index: 0, offset: 7 },
    });
  });

  it("returns null when the quote is gone", () => {
    expect(locateQuote(["something else"], "loss converges")).toBeNull();
    expect(locateQuote(["anything"], "   ")).toBeNull();
  });
});

describe("reply comment draft", () => {
  afterEach(() => {
    const draft = readReplyCommentDraft();
    if (draft) clearReplyCommentDraft(draft.messageId);
  });

  it("keeps a draft until its own reply clears it", () => {
    saveReplyCommentDraft({ messageId: "message-a", quote: "quoted", text: "half typed" });

    // Another reply closing its toolbar leaves this draft alone.
    clearReplyCommentDraft("message-b");
    expect(readReplyCommentDraft()).toEqual({
      messageId: "message-a",
      quote: "quoted",
      text: "half typed",
    });

    clearReplyCommentDraft("message-a");
    expect(readReplyCommentDraft()).toBeNull();
  });
});
