/**
 * Codex's subscription quota for the `/usage` card.
 *
 * Read live from a short-lived `codex app-server` (`account/rateLimits/read`),
 * the same numbers Codex's own `/status` shows. Codex describes each window by
 * its length rather than by a fixed slot: a Plus plan reports a 5-hour and a
 * weekly window, while some Pro plans report only the weekly one, and it then
 * arrives in the slot the 5-hour window uses elsewhere. The card labels windows
 * by length, so every plan reads correctly.
 *
 * @module CodexUsageLimits
 */
import {
  CodexUsageError,
  type CodexSettings,
  type CodexUsageLimits,
  type CodexUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { readCodexAccountRateLimits } from "../provider/Layers/CodexProvider.ts";

const CACHE_TTL_MS = 30_000;
/** Starting the app server is the slow part; a cold start takes a few seconds. */
const READ_TIMEOUT_MS = 20_000;

type CodexRateLimitsResponse = CodexSchema.V2GetAccountRateLimitsResponse;
type CodexRateLimitWindow = NonNullable<CodexRateLimitsResponse["rateLimits"]["primary"]>;
type CodexRateLimitSnapshot = Pick<
  CodexRateLimitsResponse["rateLimits"],
  "limitId" | "limitName" | "primary" | "secondary"
>;

function toWindow(
  window: CodexRateLimitWindow | null | undefined,
  limitName: string | null,
): CodexUsageWindow | null {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins ?? null,
    // Codex reports epoch seconds.
    resetsAt:
      typeof window.resetsAt === "number"
        ? DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1000))
        : null,
    limitName,
  };
}

function snapshotWindows(
  snapshot: CodexRateLimitSnapshot,
  limitName: string | null,
): CodexUsageWindow[] {
  return [toWindow(snapshot.primary, limitName), toWindow(snapshot.secondary, limitName)]
    .filter((window): window is CodexUsageWindow => window !== null)
    .toSorted(
      (left, right) =>
        (left.windowMinutes ?? Number.MAX_SAFE_INTEGER) -
        (right.windowMinutes ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * Flattens Codex's answer into the card's windows: the account's main limit
 * first, shortest window first, then any other named limit Codex reports
 * (such as a per-model allowance), labelled with its name.
 */
export function parseCodexRateLimits(
  response: CodexRateLimitsResponse,
  fetchedAt: string,
): CodexUsageLimits {
  const main = response.rateLimits;
  const windows = snapshotWindows(main, null);
  for (const [limitId, snapshot] of Object.entries(response.rateLimitsByLimitId ?? {})) {
    // The main limit is repeated in the map under its own id.
    if (limitId === main.limitId || snapshot.limitId === main.limitId) continue;
    const name = snapshot.limitName?.trim() || limitId;
    windows.push(...snapshotWindows(snapshot, name));
  }
  return {
    windows,
    planType: main.planType ?? null,
    fetchedAt,
  };
}

/**
 * Builds a reader with a short in-memory cache, so reopening the card does not
 * start another app server. Keyed by the Codex home it read.
 */
export const makeCodexUsageLimitsReader = Effect.sync(() => {
  let cached: {
    readonly homePath: string;
    readonly atMs: number;
    readonly limits: CodexUsageLimits;
  } | null = null;

  const read = Effect.fn("CodexUsageLimits.read")(function* (
    codexSettings: CodexSettings,
  ): Effect.fn.Return<CodexUsageLimits, CodexUsageError, ChildProcessSpawner.ChildProcessSpawner> {
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      cached &&
      cached.homePath === codexSettings.homePath &&
      nowMs - cached.atMs < CACHE_TTL_MS
    ) {
      return cached.limits;
    }
    if (!codexSettings.enabled) {
      return yield* new CodexUsageError({
        reason: "unavailable",
        detail: "Codex is turned off in T3 Code's provider settings on this machine.",
      });
    }

    const answer = yield* readCodexAccountRateLimits(codexSettings).pipe(
      Effect.scoped,
      Effect.timeoutOption(READ_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(answer)) {
      return yield* new CodexUsageError({
        reason: "requestFailed",
        detail:
          "Codex did not report its limits. Check that Codex is installed and up to date on this machine.",
      });
    }
    const result = answer.value;
    if (result._tag === "NotSignedIn") {
      return yield* new CodexUsageError({
        reason: "notSignedIn",
        detail: "Codex is not signed in on this machine. Run `codex login`, then try again.",
      });
    }
    if (result._tag === "NoSubscription") {
      return yield* new CodexUsageError({
        reason: "unavailable",
        detail:
          result.accountType === "apiKey"
            ? "Codex is signed in with an API key, which is billed per token and has no plan limits."
            : "Codex is using Amazon Bedrock, which has no ChatGPT plan limits.",
      });
    }

    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    const limits = parseCodexRateLimits(result.response, fetchedAt);
    cached = { homePath: codexSettings.homePath, atMs: nowMs, limits };
    return limits;
  });

  return { read } as const;
});
