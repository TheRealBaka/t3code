import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChatImageAttachment, ModelSelection } from "./orchestration.ts";

/**
 * Side chats are ephemeral forks of a thread's provider conversation, in the
 * spirit of Claude Code's `/btw` and Codex's `/side`. They live only in server
 * memory: nothing is persisted, and they expire when closed or after idling.
 */
export const SideChatId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type SideChatId = typeof SideChatId.Type;

export const SideChatAskInput = Schema.Struct({
  threadId: ThreadId,
  sideChatId: SideChatId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  /** Overrides the thread's model and effort for this side chat; defaults to the thread's own. */
  modelSelection: Schema.optional(ModelSelection),
  /**
   * Images already uploaded through `attachments.createUploadUrl`, the same way
   * a main turn stages them. The fork reads them off disk and sends them as
   * image content blocks, so only image attachments are accepted here.
   */
  attachments: Schema.optional(Schema.Array(ChatImageAttachment)),
});
export type SideChatAskInput = typeof SideChatAskInput.Type;

export const SideChatEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("started"),
    sideChatId: SideChatId,
    provider: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("delta"),
    sideChatId: SideChatId,
    text: Schema.String,
  }),
  /**
   * Context window accounting for the fork, reported once the turn's result
   * message lands. `maxTokens` is absent when neither the SDK nor the model
   * catalog knows the window size; the meter then shows tokens without a ring.
   */
  Schema.Struct({
    type: Schema.Literal("usage"),
    sideChatId: SideChatId,
    usedTokens: NonNegativeInt,
    maxTokens: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    sideChatId: SideChatId,
    text: Schema.String,
  }),
]);
export type SideChatEvent = typeof SideChatEvent.Type;

export const SideChatCloseInput = Schema.Struct({
  sideChatId: SideChatId,
});
export type SideChatCloseInput = typeof SideChatCloseInput.Type;

export class SideChatError extends Schema.TaggedErrorClass<SideChatError>()("SideChatError", {
  detail: Schema.String,
  /** Set when the thread's provider cannot fork conversations. */
  unsupportedProvider: Schema.optional(Schema.Boolean),
}) {
  override get message(): string {
    return this.detail;
  }
}
