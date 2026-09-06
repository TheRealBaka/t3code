import { describe, expect, it } from "@effect/vitest";

import { parseClaudeCredentials, parseClaudeUsageResponse } from "./ClaudeUsageLimits.ts";

/** Trimmed from a real `GET /api/oauth/usage` body on a Max subscription. */
const USAGE_BODY = {
  five_hour: {
    utilization: 90.0,
    resets_at: "2026-09-06T03:29:59.578188+00:00",
    limit_dollars: null,
  },
  seven_day: { utilization: 15.0, resets_at: "2026-09-08T10:59:59.578208+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 90,
      resets_at: "2026-09-06T03:29:59.578188+00:00",
      scope: null,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 15,
      resets_at: "2026-09-08T10:59:59.578208+00:00",
      scope: null,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 25,
      resets_at: "2026-09-08T10:59:59.578383+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

const options = { fetchedAt: "2026-09-06T01:00:00.000Z", subscriptionType: "max" };

describe("claude usage limits", () => {
  it("reads the session and weekly windows the endpoint reports", () => {
    const limits = parseClaudeUsageResponse(USAGE_BODY, options);

    expect(limits.fiveHour).toEqual({
      usedPercent: 90,
      resetsAt: "2026-09-06T03:29:59.578188+00:00",
    });
    expect(limits.sevenDay).toEqual({
      usedPercent: 15,
      resetsAt: "2026-09-08T10:59:59.578208+00:00",
    });
    expect(limits.subscriptionType).toBe("max");
    expect(limits.fetchedAt).toBe("2026-09-06T01:00:00.000Z");
  });

  it("treats a window the plan does not have as absent rather than zero", () => {
    expect(parseClaudeUsageResponse(USAGE_BODY, options).sevenDayOpus).toBeNull();
    expect(parseClaudeUsageResponse({}, options).fiveHour).toBeNull();
  });

  it("keeps only the model-scoped weekly entries, with their display names", () => {
    expect(parseClaudeUsageResponse(USAGE_BODY, options).scoped).toEqual([
      { label: "Fable", usedPercent: 25, resetsAt: "2026-09-08T10:59:59.578383+00:00" },
    ]);
  });

  it("survives a body shaped differently from what this version expects", () => {
    const limits = parseClaudeUsageResponse({ five_hour: "soon", limits: "none" }, options);
    expect(limits.fiveHour).toBeNull();
    expect(limits.scoped).toEqual([]);
  });

  it("lifts the access token and plan out of the stored credentials", () => {
    const credentials = parseClaudeCredentials(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token-value",
          refreshToken: "refresh-value",
          expiresAt: 1788676552061,
          subscriptionType: "max",
        },
      }),
    );

    expect(credentials).toEqual({
      accessToken: "token-value",
      subscriptionType: "max",
      expiresAtMs: 1788676552061,
    });
  });

  it("reports no credentials for a file that is unparsable or signed out", () => {
    expect(parseClaudeCredentials("not json")).toBeNull();
    expect(parseClaudeCredentials("{}")).toBeNull();
    expect(
      parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } })),
    ).toBeNull();
  });
});
