/**
 * SideChatCoordinator — ephemeral forks of a thread's provider conversation.
 *
 * A side chat is the server half of Claude Code's `/btw`: the user asks a
 * question *about* the conversation they are looking at, and the answer comes
 * from a fork of the provider session so the main thread's context is never
 * touched. Forks have no tool access — they answer from what is already in
 * context — and follow-up questions resume the fork, so a side chat keeps its
 * own memory of earlier side exchanges.
 *
 * Nothing here is persisted. Entries live in this service's map for the life
 * of the server process and are dropped when the client closes them or after
 * `IDLE_TIMEOUT_MS` without use (swept lazily, on the next `ask`/`close`).
 *
 * @module sideChat/SideChatCoordinator
 */
import {
  type Options as ClaudeQueryOptions,
  query as claudeQuery,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ChatImageAttachment,
  ClaudeSettings,
  isProviderSendTurnSupportedImageMimeType,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type SideChatAskInput,
  type SideChatCloseInput,
  SideChatError,
  type SideChatEvent,
  type SideChatId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ClaudeModelCatalog,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");

/** A side chat that has not been used for this long is dropped on next access. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Same sources the Claude adapter reads, so the fork sees the same project
 * configuration as the thread it was forked from.
 */
// Read-only tools stay available so `$skill` and `@file` mentions resolve; anything
// that edits, runs commands, reaches the network, or spawns agents is blocked.
const SIDE_CHAT_BLOCKED_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "KillShell",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;
const SIDE_CHAT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "LS", "Skill"] as const;
const SIDE_CHAT_MAX_TURNS = 8;

const SIDE_CHAT_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/**
 * Sent once, ahead of the first question, to tell the fork what it is. The
 * fork inherits the thread's full coding-session context, so without this it
 * happily tries to keep working on the task.
 */
const SIDE_CHAT_PREAMBLE = [
  "You are answering a side question about this conversation.",
  "Answer from what is already in context. Do not use tools, read or edit files, or run commands.",
  "Keep the answer short and direct.",
].join(" ");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  piAgent: "Pi",
};

interface SideChatExchange {
  readonly prompt: string;
  readonly answer: string;
}

/** Everything a fork needs from the thread's Claude provider instance. */
interface ClaudeInstanceContext {
  readonly claudeEnvironment: NodeJS.ProcessEnv;
  readonly executablePath: string;
  readonly catalog: ClaudeModelCatalog;
}

/** Where a fork runs and what it runs as. */
interface SideChatThreadContext {
  readonly modelSelection: ModelSelection;
  readonly cwd: string | undefined;
}

interface SideChatEntry {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /** Claude session id of the thread this side chat was forked from. */
  readonly parentSessionId: string;
  /** Claude session id of the fork, known once the SDK reports it. */
  forkSessionId: string | undefined;
  readonly createdAt: number;
  lastUsedAt: number;
  readonly exchanges: Array<SideChatExchange>;
}

export class SideChatCoordinator extends Context.Service<
  SideChatCoordinator,
  {
    /**
     * Fork the thread's provider conversation (or resume this side chat's
     * existing fork) and stream the answer back.
     */
    readonly ask: (input: SideChatAskInput) => Stream.Stream<SideChatEvent, SideChatError>;

    /** Drop a side chat. Closing an unknown id is a no-op. */
    readonly close: (input: SideChatCloseInput) => Effect.Effect<void>;
  }
>()("t3/sideChat/SideChatCoordinator") {}

type SideChatEventQueue = Queue.Queue<SideChatEvent, SideChatError | Cause.Done>;

const unsupportedProvider = (provider: ProviderDriverKind): SideChatError =>
  new SideChatError({
    detail: `Side chats are not available for ${PROVIDER_LABELS[provider] ?? provider} threads yet.`,
    unsupportedProvider: true,
  });

/**
 * Pull the Claude session id out of a persisted resume cursor. The Claude
 * adapter writes `{ threadId, resume, resumeSessionAt, turnCount }`; older
 * rows used `sessionId`.
 */
function readClaudeParentSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as { resume?: unknown; sessionId?: unknown };
  const candidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  return candidate !== undefined && UUID_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * The SDK stamps hook messages with a transient session id; every other
 * message carries the durable one. Mirrors the Claude adapter's rule.
 */
function readDurableSessionId(message: SDKMessage): string | undefined {
  if (typeof message.session_id !== "string" || message.session_id.length === 0) {
    return undefined;
  }
  if (
    message.type === "system" &&
    (message.subtype === "hook_started" ||
      message.subtype === "hook_progress" ||
      message.subtype === "hook_response")
  ) {
    return undefined;
  }
  return message.session_id;
}

function isSubagentMessage(message: SDKMessage): boolean {
  const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return parentToolUseId !== null && parentToolUseId !== undefined;
}

/** Incremental assistant text from a partial-message stream event. */
function readStreamDeltaText(message: SDKMessage): string | undefined {
  if (message.type !== "stream_event" || isSubagentMessage(message)) {
    return undefined;
  }
  const { event } = message;
  if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") {
    return undefined;
  }
  return event.delta.text.length > 0 ? event.delta.text : undefined;
}

/** Full assistant text from a completed assistant message. */
function readAssistantText(message: SDKMessage): string | undefined {
  if (message.type !== "assistant" || isSubagentMessage(message)) {
    return undefined;
  }
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: Array<string> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push(candidate.text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/** Final text carried by a successful result message. */
function readResultText(message: SDKMessage): string | undefined {
  if (message.type !== "result") {
    return undefined;
  }
  const value = (message as { result?: unknown }).result;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** First user-facing error reported by a failed result message. */
function readResultError(message: SDKMessage): string | undefined {
  if (message.type !== "result" || message.subtype === "success") {
    return undefined;
  }
  if (!Array.isArray(message.errors)) {
    return undefined;
  }
  return message.errors.find(
    (error) => typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
  );
}

const nonNegativeInteger = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/**
 * Tokens the fork is carrying, summed the way the Claude adapter sums them for
 * `thread.token-usage.updated`: fresh input plus both cache buckets plus output.
 */
function readResultUsedTokens(message: SDKMessage): number | undefined {
  if (message.type !== "result") {
    return undefined;
  }
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const total =
    nonNegativeInteger(record.input_tokens) +
    nonNegativeInteger(record.cache_creation_input_tokens) +
    nonNegativeInteger(record.cache_read_input_tokens) +
    nonNegativeInteger(record.output_tokens);
  return total > 0 ? total : undefined;
}

/** Widest window the SDK reported for the models this answer touched. */
function readResultContextWindow(message: SDKMessage): number | undefined {
  if (message.type !== "result") {
    return undefined;
  }
  const modelUsage = (message as { modelUsage?: unknown }).modelUsage;
  if (!modelUsage || typeof modelUsage !== "object") {
    return undefined;
  }
  let widest = 0;
  for (const value of Object.values(modelUsage as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const contextWindow = (value as { contextWindow?: unknown }).contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow)) {
      widest = Math.max(widest, contextWindow);
    }
  }
  return widest > 0 ? Math.round(widest) : undefined;
}

/** Same base64 image block the Claude adapter sends for a main turn's images. */
function buildSideChatUserMessage(
  text: string,
  images: ReadonlyArray<{ readonly mimeType: string; readonly bytes: Uint8Array }>,
): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  for (const image of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: Buffer.from(image.bytes).toString("base64"),
      },
    });
  }
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: content as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

/**
 * A prompt with images has to go in as streaming input. Closing the iterable
 * right after the one message is what tells the SDK the turn's input is done.
 */
async function* singleUserMessage(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield message;
}

function sideChatErrorFromCause(cause: Cause.Cause<SideChatError>): SideChatError {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      return reason.error;
    }
  }
  return new SideChatError({ detail: "The side chat failed unexpectedly." });
}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const sessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const modelManifest = yield* ModelManifest.ModelManifest;

  const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
  const entries = new Map<SideChatId, SideChatEntry>();

  /**
   * Lazy idle expiry. Cheaper and more predictable than a timer fiber: side
   * chats are only observable through `ask`/`close`, so an entry that nobody
   * touches costs one map slot until the next call sweeps it.
   */
  const sweepExpired = (now: number) => {
    for (const [sideChatId, entry] of entries) {
      if (now - entry.lastUsedAt >= IDLE_TIMEOUT_MS) {
        entries.delete(sideChatId);
      }
    }
  };

  /** Where the fork should run and which model it should use. */
  const resolveThreadContext = Effect.fn("SideChatCoordinator.resolveThreadContext")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<SideChatThreadContext, SideChatError> {
    const threadShell = yield* projection.getThreadShellById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new SideChatError({
            detail: `Failed to read the thread for this side chat: ${cause.message}`,
          }),
      ),
    );
    const thread = Option.getOrUndefined(threadShell);
    if (!thread) {
      return yield* new SideChatError({ detail: "This thread is no longer available." });
    }

    const projectShell = yield* projection.getProjectShellById(thread.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new SideChatError({
            detail: `Failed to read the project for this side chat: ${cause.message}`,
          }),
      ),
    );
    return {
      modelSelection: thread.modelSelection,
      cwd: thread.worktreePath ?? Option.getOrUndefined(projectShell)?.workspaceRoot,
    };
  });

  /**
   * The per-instance Claude configuration, read the same way the provider
   * registry reads it so a side chat uses the same binary, home, and custom
   * models as the thread's provider instance.
   */
  const resolveClaudeInstance = Effect.fn("SideChatCoordinator.resolveClaudeInstance")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ClaudeInstanceContext, SideChatError> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new SideChatError({ detail: `Failed to read server settings: ${cause.message}` }),
      ),
    );
    const instanceConfig = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (!instanceConfig || instanceConfig.driver !== CLAUDE_PROVIDER) {
      return yield* new SideChatError({
        detail: "The Claude provider for this thread is no longer configured.",
      });
    }

    const rawConfig = instanceConfig.config === undefined ? {} : instanceConfig.config;
    const claudeSettings = yield* decodeClaudeSettings(rawConfig).pipe(
      Effect.mapError(
        () =>
          new SideChatError({
            detail: "The Claude provider for this thread has an invalid configuration.",
          }),
      ),
    );
    const environment = mergeProviderInstanceEnvironment(instanceConfig.environment);
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment).pipe(
      Effect.provideService(Path.Path, path),
    );
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    const manifest = yield* modelManifest.current;
    const catalog = scopeClaudeModelCatalog(
      resolveClaudeModelCatalog(manifest),
      claudeSettings.customModels,
    );

    return { claudeEnvironment, executablePath, catalog };
  });

  /**
   * Register (or look up) the side chat and resolve everything the fork needs.
   * Fails with `unsupportedProvider` for any provider that cannot fork.
   */
  const resolveEntry = Effect.fn("SideChatCoordinator.resolveEntry")(function* (
    input: SideChatAskInput,
    now: number,
  ): Effect.fn.Return<SideChatEntry, SideChatError> {
    const existing = entries.get(input.sideChatId);
    if (existing) {
      if (existing.threadId !== input.threadId) {
        return yield* new SideChatError({
          detail: "This side chat belongs to a different thread.",
        });
      }
      return existing;
    }

    const binding = yield* sessionDirectory.getBinding(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new SideChatError({
            detail: `Failed to read this thread's provider session: ${cause.message}`,
          }),
      ),
    );
    const session = Option.getOrUndefined(binding);
    if (!session) {
      return yield* new SideChatError({
        detail: "This thread has no provider session to fork yet. Send a message first.",
      });
    }
    if (session.provider !== CLAUDE_PROVIDER) {
      return yield* unsupportedProvider(session.provider);
    }

    const parentSessionId = readClaudeParentSessionId(session.resumeCursor);
    if (!parentSessionId) {
      return yield* new SideChatError({
        detail: "This thread has no resumable Claude session to fork yet. Send a message first.",
      });
    }

    const entry: SideChatEntry = {
      threadId: input.threadId,
      provider: session.provider,
      parentSessionId,
      forkSessionId: undefined,
      createdAt: now,
      lastUsedAt: now,
      exchanges: [],
    };
    entries.set(input.sideChatId, entry);
    return entry;
  });

  /**
   * Reads the staged images off disk the same way the Claude adapter does for a
   * main turn, so a side question can point at a screenshot.
   */
  const readSideChatImages = Effect.fn("SideChatCoordinator.readSideChatImages")(function* (
    attachments: ReadonlyArray<ChatImageAttachment> | undefined,
  ): Effect.fn.Return<
    Array<{ readonly mimeType: string; readonly bytes: Uint8Array }>,
    SideChatError
  > {
    const images: Array<{ readonly mimeType: string; readonly bytes: Uint8Array }> = [];
    for (const attachment of attachments ?? []) {
      if (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType)) {
        return yield* new SideChatError({
          detail: `Side chats cannot read '${attachment.mimeType}' images.`,
        });
      }
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new SideChatError({
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          () =>
            new SideChatError({ detail: `Failed to read the attachment '${attachment.name}'.` }),
        ),
      );
      images.push({ mimeType: attachment.mimeType, bytes });
    }
    return images;
  });

  const buildQueryOptions = (params: {
    readonly entry: SideChatEntry;
    readonly cwd: string | undefined;
    readonly modelSelection: ModelSelection;
    readonly instance: ClaudeInstanceContext;
    readonly abortController: AbortController;
  }): ClaudeQueryOptions => {
    const { catalog } = params.instance;
    const resolvedSelection: ModelSelection = {
      ...params.modelSelection,
      model: resolveClaudeModelSlug(catalog, params.modelSelection.model),
    };
    const apiModelId = resolveClaudeCatalogApiModelId(catalog, resolvedSelection);
    const effort = normalizeClaudeCatalogEffort(
      catalog,
      resolveClaudeCatalogEffort(
        catalog,
        resolvedSelection.model,
        getModelSelectionStringOptionValue(resolvedSelection, "effort"),
      ),
      resolvedSelection.model,
    );
    // First ask forks the parent session; later asks resume the fork so the
    // side chat keeps its own memory without ever writing to the thread.
    const resume = params.entry.forkSessionId ?? params.entry.parentSessionId;

    return {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(apiModelId ? { model: apiModelId } : {}),
      ...(effort ? { effort: effort as unknown as NonNullable<ClaudeQueryOptions["effort"]> } : {}),
      pathToClaudeCodeExecutable: params.instance.executablePath,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [...SIDE_CHAT_SETTING_SOURCES],
      resume,
      ...(params.entry.forkSessionId === undefined ? { forkSession: true } : {}),
      // A side chat answers from context: no tools, no MCP servers, and none
      // of the user's hooks (which belong to real turns, not to questions).
      allowedTools: [...SIDE_CHAT_ALLOWED_TOOLS],
      // allowedTools only skips prompts; the block list is what keeps the
      // built-in tools out of the model's reach, matching /btw's no-tool rule.
      disallowedTools: [...SIDE_CHAT_BLOCKED_TOOLS],
      mcpServers: {},
      strictMcpConfig: true,
      settings: { disableAllHooks: true },
      maxTurns: SIDE_CHAT_MAX_TURNS,
      includePartialMessages: true,
      abortController: params.abortController,
      env: params.instance.claudeEnvironment,
    };
  };

  /**
   * Drive one Claude fork turn, publishing `delta` events as text arrives and
   * a final `complete` with the whole answer.
   */
  const runClaudeAsk = Effect.fn("SideChatCoordinator.runClaudeAsk")(function* (
    input: SideChatAskInput,
    entry: SideChatEntry,
    queue: SideChatEventQueue,
  ): Effect.fn.Return<void, SideChatError> {
    const threadContext = yield* resolveThreadContext(entry.threadId);
    // A side chat may pick its own model and effort; the thread's own is the default.
    const modelSelection = input.modelSelection ?? threadContext.modelSelection;
    const instance = yield* resolveClaudeInstance(modelSelection.instanceId);

    const abortController = new AbortController();
    const options = buildQueryOptions({
      entry,
      cwd: threadContext.cwd,
      modelSelection,
      instance,
      abortController,
    });
    const images = yield* readSideChatImages(input.attachments);
    const promptText =
      entry.exchanges.length === 0 ? `${SIDE_CHAT_PREAMBLE}\n\n${input.prompt}` : input.prompt;
    // A text-only question stays on the plain string prompt; images have to go
    // in as streaming input, which the one-message iterable closes right after.
    const prompt =
      images.length === 0
        ? promptText
        : singleUserMessage(buildSideChatUserMessage(promptText, images));

    const runtime = yield* Effect.try({
      try: () => claudeQuery({ prompt, options }),
      catch: (cause) =>
        new SideChatError({
          detail: `Failed to start the side chat: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    let streamedText = "";
    let assistantText: string | undefined;
    let resultText: string | undefined;
    let resultError: string | undefined;
    let usedTokens: number | undefined;
    let resultContextWindow: number | undefined;

    yield* Stream.fromAsyncIterable(
      runtime,
      (cause) =>
        new SideChatError({
          detail: `The side chat failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ).pipe(
      Stream.runForEach((message) => {
        const sessionId = readDurableSessionId(message);
        if (sessionId !== undefined && sessionId !== entry.parentSessionId) {
          // The fork announces itself with a fresh session id on its init
          // message; that id is what later asks resume.
          entry.forkSessionId = sessionId;
        }

        assistantText = readAssistantText(message) ?? assistantText;
        resultText = readResultText(message) ?? resultText;
        resultError = readResultError(message) ?? resultError;
        usedTokens = readResultUsedTokens(message) ?? usedTokens;
        resultContextWindow = readResultContextWindow(message) ?? resultContextWindow;

        const delta = readStreamDeltaText(message);
        if (delta === undefined) {
          return Effect.void;
        }
        streamedText += delta;
        return Queue.offer(queue, {
          type: "delta",
          sideChatId: input.sideChatId,
          text: delta,
        }).pipe(Effect.asVoid);
      }),
      Effect.onInterrupt(() => Effect.sync(() => abortController.abort())),
    );

    const answer = (streamedText || assistantText || resultText || "").trim();
    if (answer.length === 0) {
      return yield* new SideChatError({
        detail: resultError ?? "The side chat did not return an answer.",
      });
    }

    entry.exchanges.push({ prompt: input.prompt, answer });
    entry.lastUsedAt = yield* Clock.currentTimeMillis;

    if (usedTokens !== undefined) {
      // The SDK reports the window the fork actually ran with; the catalog is
      // the fallback for results that leave `modelUsage` out.
      const maxTokens =
        resultContextWindow ??
        resolveClaudeCatalogContextWindowTokens(instance.catalog, modelSelection);
      yield* Queue.offer(queue, {
        type: "usage",
        sideChatId: input.sideChatId,
        usedTokens,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }).pipe(Effect.asVoid);
    }

    yield* Queue.offer(queue, {
      type: "complete",
      sideChatId: input.sideChatId,
      text: answer,
    }).pipe(Effect.asVoid);
  });

  const publish = Effect.fn("SideChatCoordinator.publish")(function* (
    input: SideChatAskInput,
    queue: SideChatEventQueue,
  ): Effect.fn.Return<void, SideChatError> {
    const now = yield* Clock.currentTimeMillis;
    sweepExpired(now);

    const entry = yield* resolveEntry(input, now);
    entry.lastUsedAt = now;

    yield* Queue.offer(queue, {
      type: "started",
      sideChatId: input.sideChatId,
      provider: entry.provider,
    }).pipe(Effect.asVoid);

    yield* runClaudeAsk(input, entry, queue);
  });

  const ask: SideChatCoordinator["Service"]["ask"] = (input) =>
    Stream.callback<SideChatEvent, SideChatError>((queue) =>
      publish(input, queue).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Queue.fail(queue, sideChatErrorFromCause(cause)).pipe(Effect.asVoid),
        ),
        Effect.andThen(Queue.end(queue)),
        Effect.forkScoped,
      ),
    );

  const close: SideChatCoordinator["Service"]["close"] = (input) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        entries.delete(input.sideChatId);
        sweepExpired(now);
      }),
    );

  return { ask, close } satisfies SideChatCoordinator["Service"];
});

export const layer = Layer.effect(SideChatCoordinator, make);
