/**
 * Claude subscription quota, read from the account service.
 *
 * `UsageService` answers "what did I spend" by scanning transcripts on disk.
 * This answers the different question "how much of my plan is left", and it is
 * the same source Claude Code's own `/usage` dialog reads: a GET against the
 * OAuth usage endpoint, authorised with the access token Claude Code already
 * stored in its config directory. Reading it costs no message quota.
 *
 * The token is read, used as a bearer header, and discarded. It is never
 * logged, never returned to a client, and never put in an error detail.
 *
 * @module ClaudeUsageLimits
 */
import {
  ClaudeUsageError,
  type ClaudeScopedUsageWindow,
  type ClaudeUsageLimits,
  type ClaudeUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/** The endpoint Claude Code's `/usage` reads. Reporting only; spends nothing. */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * Long enough that reopening the card does not re-hit the account service,
 * short enough that the numbers move while a turn is running.
 */
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ClaudeStoredCredentials {
  readonly accessToken: string;
  readonly subscriptionType: string | null;
  readonly expiresAtMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Narrows the `.credentials.json` Claude Code writes next to its config. Only
 * the three fields we use are lifted out; everything else stays on disk.
 */
export function parseClaudeCredentials(raw: string): ClaudeStoredCredentials | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = asRecord(asRecord(document)?.["claudeAiOauth"]);
  if (!oauth) return null;
  const accessToken = readNonEmptyString(oauth["accessToken"]);
  if (!accessToken) return null;
  const expiresAt = oauth["expiresAt"];
  return {
    accessToken,
    subscriptionType: readNonEmptyString(oauth["subscriptionType"]),
    expiresAtMs: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

/** Percentages arrive as 0-100 floats; a bad one must not render as a bar off the end. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function readWindow(value: unknown): ClaudeUsageWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = record["utilization"];
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  return {
    usedPercent: clampPercent(utilization),
    resetsAt: readNonEmptyString(record["resets_at"]),
  };
}

/**
 * The `limits` array carries the windows that have no fixed key, notably the
 * per-model weekly allowances whose display name only the service knows.
 */
function readScopedWindows(value: unknown): ClaudeScopedUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const scoped: ClaudeScopedUsageWindow[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || record["kind"] !== "weekly_scoped") continue;
    const percent = record["percent"];
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const model = asRecord(asRecord(record["scope"])?.["model"]);
    const label = readNonEmptyString(model?.["display_name"]);
    if (!label) continue;
    scoped.push({
      label,
      usedPercent: clampPercent(percent),
      resetsAt: readNonEmptyString(record["resets_at"]),
    });
  }
  return scoped;
}

/**
 * Every window is optional and every one of them can be an explicit `null` for
 * a plan that does not have it, so absence is normal rather than an error.
 */
export function parseClaudeUsageResponse(
  document: unknown,
  options: { readonly fetchedAt: string; readonly subscriptionType: string | null },
): ClaudeUsageLimits {
  const record = asRecord(document) ?? {};
  return {
    fiveHour: readWindow(record["five_hour"]),
    sevenDay: readWindow(record["seven_day"]),
    sevenDayOpus: readWindow(record["seven_day_opus"]),
    scoped: readScopedWindows(record["limits"]),
    subscriptionType: options.subscriptionType,
    fetchedAt: options.fetchedAt,
  };
}

/**
 * Claude Code keeps credentials at `<configDir>/.credentials.json`. When the
 * config dir is a plain home directory the file sits under `.claude` instead,
 * which is the default T3 Code resolves to when no Claude home is configured.
 */
export function claudeCredentialsCandidates(path: Path.Path, homePath: string): readonly string[] {
  return [
    path.join(homePath, ".claude", ".credentials.json"),
    path.join(homePath, ".credentials.json"),
  ];
}

const NO_CREDENTIALS_DETAIL =
  "Claude Code is not signed in on this machine, so its subscription usage is unavailable. Run `claude` and sign in, then try again.";

/**
 * Builds a reader with a short in-memory cache. One reader per server; the
 * cache is keyed by the Claude home it read, so switching homes re-reads.
 */
export const makeClaudeUsageLimitsReader = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;

  let cached:
    | { readonly homePath: string; readonly atMs: number; readonly limits: ClaudeUsageLimits }
    | null = null;

  const readCredentials = Effect.fn("ClaudeUsageLimits.readCredentials")(function* (
    homePath: string,
  ) {
    for (const candidate of claudeCredentialsCandidates(path, homePath)) {
      const raw = yield* fileSystem
        .readFileString(candidate)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (raw === null) continue;
      const credentials = parseClaudeCredentials(raw);
      if (credentials) return credentials;
    }
    return null;
  });

  const read = Effect.fn("ClaudeUsageLimits.read")(function* (homePath: string) {
    const nowMs = yield* Clock.currentTimeMillis;
    if (cached && cached.homePath === homePath && nowMs - cached.atMs < CACHE_TTL_MS) {
      return cached.limits;
    }

    const credentials = yield* readCredentials(homePath);
    if (!credentials) {
      return yield* new ClaudeUsageError({
        reason: "noCredentials",
        detail: NO_CREDENTIALS_DETAIL,
      });
    }

    const request = HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
      HttpClientRequest.bearerToken(credentials.accessToken),
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    // The token must not reach a log or an error detail, so the transport
    // failure is discarded rather than carried: `detail` is all the client sees.
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeoutOption(REQUEST_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(response)) {
      return yield* new ClaudeUsageError({
        reason: "requestFailed",
        detail: "Claude's usage service did not respond. Check this machine's network access.",
      });
    }
    const httpResponse = response.value;
    if (httpResponse.status === 401 || httpResponse.status === 403) {
      return yield* new ClaudeUsageError({
        reason: "noCredentials",
        detail: "Claude rejected the stored sign-in. Run `claude` to refresh it, then try again.",
      });
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return yield* new ClaudeUsageError({
        reason: "requestFailed",
        detail: `Claude's usage service returned HTTP ${httpResponse.status}.`,
      });
    }
    const document = yield* httpResponse.json.pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (document === null) {
      return yield* new ClaudeUsageError({
        reason: "requestFailed",
        detail: "Claude's usage service returned a response this version cannot read.",
      });
    }

    const fetchedAt = yield* DateTime.now;
    const limits = parseClaudeUsageResponse(document, {
      fetchedAt: DateTime.formatIso(fetchedAt),
      subscriptionType: credentials.subscriptionType,
    });
    cached = { homePath, atMs: nowMs, limits };
    return limits;
  });

  return { read } as const;
});
