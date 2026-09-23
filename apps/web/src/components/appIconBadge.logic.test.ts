import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { countUnseenCompletedThreads } from "./appIconBadge.logic";

const environmentId = EnvironmentId.make("environment-local");

function makeThread(id: string, overrides: { archivedAt?: string | null } = {}) {
  return {
    id: ThreadId.make(id),
    environmentId,
    archivedAt: overrides.archivedAt ?? null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    session: null,
    latestTurn: {
      turnId: "turn-1" as never,
      state: "completed" as const,
      assistantMessageId: null,
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: "2026-03-09T10:05:00.000Z",
    },
  };
}

function visitKey(id: string): string {
  return scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
}

describe("countUnseenCompletedThreads", () => {
  it("counts threads that finished after their last visit, by scoped thread key", () => {
    const threads = [makeThread("unseen"), makeThread("seen"), makeThread("never-visited")];
    const count = countUnseenCompletedThreads(threads, {
      [visitKey("unseen")]: "2026-03-09T10:01:00.000Z",
      [visitKey("seen")]: "2026-03-09T10:05:00.000Z",
    });
    expect(count).toBe(1);
  });

  it("ignores archived threads", () => {
    const threads = [makeThread("archived", { archivedAt: "2026-03-09T10:06:00.000Z" })];
    const count = countUnseenCompletedThreads(threads, {
      [visitKey("archived")]: "2026-03-09T10:01:00.000Z",
    });
    expect(count).toBe(0);
  });
});
