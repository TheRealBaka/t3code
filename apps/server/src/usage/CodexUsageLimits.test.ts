import { describe, expect, it } from "@effect/vitest";

import { parseCodexRateLimits } from "./CodexUsageLimits.ts";

const FETCHED_AT = "2026-09-30T12:00:00.000Z";
const RESETS_AT_SECONDS = 1_791_114_974;
const RESETS_AT_ISO = "2026-10-04T11:56:14.000Z";

describe("parseCodexRateLimits", () => {
  it("reads a weekly-only plan whose week arrives in the primary slot", () => {
    // The shape a Pro Lite account returns: one weekly window, repeated in the
    // by-id map under the main limit's own id.
    const main = {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: RESETS_AT_SECONDS },
      secondary: null,
      planType: "prolite" as const,
    };
    const limits = parseCodexRateLimits(
      { rateLimits: main, rateLimitsByLimitId: { codex: main } },
      FETCHED_AT,
    );

    expect(limits).toEqual({
      windows: [
        { usedPercent: 17, windowMinutes: 10_080, resetsAt: RESETS_AT_ISO, limitName: null },
      ],
      planType: "prolite",
      fetchedAt: FETCHED_AT,
    });
  });

  it("lists a 5-hour and a weekly window shortest first", () => {
    const limits = parseCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 60, windowDurationMins: 10_080, resetsAt: null },
          secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
          planType: "plus",
        },
      },
      FETCHED_AT,
    );

    expect(limits.windows.map((window) => [window.windowMinutes, window.usedPercent])).toEqual([
      [300, 12],
      [10_080, 60],
    ]);
    expect(limits.planType).toBe("plus");
  });

  it("adds other named limits after the main one", () => {
    const limits = parseCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
        },
        rateLimitsByLimitId: {
          "codex-spark": {
            limitId: "codex-spark",
            limitName: "GPT-5 Codex Spark",
            primary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
          },
        },
      },
      FETCHED_AT,
    );

    expect(limits.windows.map((window) => window.limitName)).toEqual([null, "GPT-5 Codex Spark"]);
  });
});
