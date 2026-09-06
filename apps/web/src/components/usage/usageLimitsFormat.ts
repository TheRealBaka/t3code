// @effect-diagnostics globalDate:off -- Reset times are wall-clock instants rendered in the viewer's own zone via Intl.
/**
 * Display formatting for Claude's subscription quota windows.
 *
 * @module usageLimitsFormat
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const RESET_CLOCK = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * A window is most useful as a countdown while it is close, and as a wall-clock
 * time once it is far enough away that counting down says nothing. A window
 * whose reset has already passed reads as unknown rather than as "0m": the
 * numbers beside it are from before the rollover.
 */
export function formatResetTime(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;

  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return null;
  if (remainingMs < MINUTE_MS) return "resets in under a minute";
  if (remainingMs < HOUR_MS) return `resets in ${Math.floor(remainingMs / MINUTE_MS)}m`;
  if (remainingMs < DAY_MS) {
    const hours = Math.floor(remainingMs / HOUR_MS);
    const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes}m`;
  }
  return `resets ${RESET_CLOCK.format(new Date(resetMs))}`;
}

/** Whole percents: a quota bar does not earn a decimal place. */
export function formatUsedPercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}% used`;
}
