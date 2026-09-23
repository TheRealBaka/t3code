import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { hasUnseenCompletion } from "./Sidebar.logic";

type BadgeThread = Parameters<typeof hasUnseenCompletion>[0] &
  Pick<EnvironmentThreadShell, "environmentId" | "id" | "archivedAt">;

/** Threads whose latest turn finished after the user last looked at them. */
export function countUnseenCompletedThreads(
  threads: ReadonlyArray<BadgeThread>,
  lastVisitedAtByThreadKey: Readonly<Record<string, string>>,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const lastVisitedAt =
      lastVisitedAtByThreadKey[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))];
    if (hasUnseenCompletion({ ...thread, lastVisitedAt })) count += 1;
  }
  return count;
}
