import { describe, expect, it } from "vite-plus/test";

import { formatResetTime, formatUsedPercent } from "./usageLimitsFormat";

const NOW = Date.parse("2026-09-06T01:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("usage limits format", () => {
  it("counts down while the window is close", () => {
    expect(formatResetTime(at(9 * MINUTE), NOW)).toBe("resets in 9m");
    expect(formatResetTime(at(2 * HOUR + 10 * MINUTE), NOW)).toBe("resets in 2h 10m");
    expect(formatResetTime(at(3 * HOUR), NOW)).toBe("resets in 3h");
  });

  it("switches to a wall clock once counting down stops saying anything", () => {
    const formatted = formatResetTime(at(50 * HOUR), NOW);
    expect(formatted).not.toBeNull();
    expect(formatted).not.toContain("resets in");
  });

  it("treats an elapsed or unreadable reset as unknown rather than zero", () => {
    expect(formatResetTime(at(-HOUR), NOW)).toBeNull();
    expect(formatResetTime("not a date", NOW)).toBeNull();
    expect(formatResetTime(null, NOW)).toBeNull();
  });

  it("rounds utilization to whole percents", () => {
    expect(formatUsedPercent(90)).toBe("90% used");
    expect(formatUsedPercent(14.6)).toBe("15% used");
  });
});
