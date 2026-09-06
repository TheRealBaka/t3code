import type {
  ChatImageAttachment,
  EnvironmentId,
  ModelSelection,
  SideChatEvent,
  ThreadId,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { request, runStream } from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  runInEnvironment,
  runStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Streams one side-chat answer. Events are handed to the caller as they land so
 * the panel can render deltas, and `stop` interrupts the stream fiber (and with
 * it the server-side request) when the reader has seen enough.
 */
export const askSideChat = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:side-chat:ask",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly sideChatId: string;
    readonly prompt: string;
    /** Omitted means "run where the thread runs"; the server resolves it. */
    readonly modelSelection?: ModelSelection | undefined;
    /** Images already uploaded for this environment, staged in the side composer. */
    readonly attachments?: ReadonlyArray<ChatImageAttachment> | undefined;
    readonly onEvent: (event: SideChatEvent) => void;
    readonly stop: Promise<void>;
  }) =>
    runStreamInEnvironment(
      input.environmentId,
      runStream(WS_METHODS.sideChatAsk, {
        threadId: input.threadId,
        sideChatId: input.sideChatId,
        prompt: input.prompt,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      }),
    ).pipe(
      Stream.runForEach((event) => Effect.sync(() => input.onEvent(event))),
      Effect.raceFirst(Effect.promise(() => input.stop)),
    ),
});

/** Drops the fork on the server; it also expires on its own after idling. */
export const closeSideChat = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:side-chat:close",
  execute: (input: { readonly environmentId: EnvironmentId; readonly sideChatId: string }) =>
    runInEnvironment(
      input.environmentId,
      request(WS_METHODS.sideChatClose, { sideChatId: input.sideChatId }),
    ),
});
