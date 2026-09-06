import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SideChatCoordinator from "./SideChatCoordinator.ts";

const THREAD_ID = ThreadId.make("thread-side-chat");
const CLAUDE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

/**
 * Counts `getBinding` calls so a test can tell "this ask reused the open side
 * chat" from "this ask resolved the thread's provider session again".
 */
interface BindingProbe {
  calls: number;
}

const makeTestLayer = (input: {
  readonly provider: string;
  readonly probe: BindingProbe;
}) => {
  const binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
    threadId: THREAD_ID,
    provider: ProviderDriverKind.make(input.provider),
    providerInstanceId: ProviderInstanceId.make(input.provider),
    resumeCursor: { threadId: THREAD_ID, resume: CLAUDE_SESSION_ID },
  };

  return SideChatCoordinator.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
          getBinding: () =>
            Effect.sync(() => {
              input.probe.calls += 1;
              return Option.some(binding);
            }),
        }),
        // The thread is gone, so every ask fails right after the side chat is
        // registered. That keeps the test off the Claude SDK while still
        // exercising registration, reuse, and expiry.
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        ModelManifest.layerTest,
        // Attachment reads need a real attachments directory; these tests never
        // stage one, but the coordinator resolves the service at construction.
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-side-chat-test-" }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.merge(TestClock.layer()),
  );
};

const ask = (coordinator: SideChatCoordinator.SideChatCoordinator["Service"], prompt: string) =>
  Effect.flip(
    Stream.runCollect(
      coordinator.ask({ threadId: THREAD_ID, sideChatId: "side-chat-1", prompt }),
    ),
  );

describe("SideChatCoordinator", () => {
  it.effect("reports providers that cannot fork a conversation", () => {
    const probe: BindingProbe = { calls: 0 };
    return Effect.gen(function* () {
      const coordinator = yield* SideChatCoordinator.SideChatCoordinator;
      const error = yield* ask(coordinator, "what did you just change?");

      expect(error._tag).toBe("SideChatError");
      expect(error.unsupportedProvider).toBe(true);
      expect(error.detail).toContain("Codex");
    }).pipe(Effect.provide(makeTestLayer({ provider: "codex", probe })));
  });

  it.effect("reuses an open side chat until it has idled out", () => {
    const probe: BindingProbe = { calls: 0 };
    return Effect.gen(function* () {
      const coordinator = yield* SideChatCoordinator.SideChatCoordinator;

      yield* ask(coordinator, "first question");
      expect(probe.calls).toBe(1);

      // Follow-ups answer from the side chat that is already open.
      yield* ask(coordinator, "second question");
      expect(probe.calls).toBe(1);

      yield* TestClock.adjust(Duration.minutes(31));
      yield* ask(coordinator, "much later question");
      expect(probe.calls).toBe(2);
    }).pipe(Effect.provide(makeTestLayer({ provider: "claudeAgent", probe })));
  });

  it.effect("closing a side chat forgets it", () => {
    const probe: BindingProbe = { calls: 0 };
    return Effect.gen(function* () {
      const coordinator = yield* SideChatCoordinator.SideChatCoordinator;

      yield* ask(coordinator, "first question");
      expect(probe.calls).toBe(1);

      yield* coordinator.close({ sideChatId: "side-chat-1" });

      yield* ask(coordinator, "asked again after closing");
      expect(probe.calls).toBe(2);
    }).pipe(Effect.provide(makeTestLayer({ provider: "claudeAgent", probe })));
  });
});
