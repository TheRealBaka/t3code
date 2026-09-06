/**
 * Side chat right-panel surface: an ephemeral fork of the thread's provider
 * conversation. Questions asked here never enter the main thread's context and
 * the fork only gets read-only tools, so it is a place to ask about the work
 * without spending the agent's attention on it.
 *
 * The composer is the main chat composer's parts — same glass shell, same
 * Lexical prompt editor, same model, effort, attachment and context-window
 * controls, same checkout row underneath — so `@file` mentions, `$skill` chips,
 * pasted images and `/` commands behave as they do below the transcript.
 */
import type {
  ChatImageAttachment,
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { createModelSelection } from "@t3tools/shared/model";
import {
  FolderGitIcon,
  FolderIcon,
  GitBranchIcon,
  MessagesSquare,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  collapseExpandedComposerCursor,
  type ComposerTrigger,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "~/composer-logic";
import type { ComposerImageAttachment } from "~/composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import { useComposerPathSearch } from "~/lib/composerPathSearchState";
import { prepareImageForAttachment } from "~/lib/imageCompression";
import { cn, randomUUID } from "~/lib/utils";
import { getAppModelOptionsForInstance, type AppModelOption } from "~/modelSelection";
import { basenameOfPath } from "~/pierre-icons";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { searchProviderSkills } from "~/providerSkillSearch";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { resolveLockedWorkspaceLabel } from "~/components/BranchToolbar.logic";
import ChatMarkdown from "~/components/ChatMarkdown";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "~/components/composerInlineChip";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { AssistantReplyComments } from "~/components/chat/AssistantReplyComments";
import {
  type ComposerCommandItem,
  ComposerCommandMenu,
} from "~/components/chat/ComposerCommandMenu";
import { ComposerCommandMenuLayer } from "~/components/chat/ComposerCommandMenuLayer";
import { searchSlashCommandItems } from "~/components/chat/composerSlashCommandSearch";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "~/components/chat/composerAttachmentFiles";
import { ComposerPrimaryActions } from "~/components/chat/ComposerPrimaryActions";
import { ContextWindowMeter } from "~/components/chat/ContextWindowMeter";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "~/components/chat/composerProviderState";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { resolveComposerMenuActiveItemId } from "~/components/chat/composerMenuHighlight";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { shouldRenderTraitsControls, TraitsPicker } from "~/components/chat/TraitsPicker";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import {
  formatSideChatSelectionsForPrompt,
  selectSideChatSelections,
  useSideChatSelectionStore,
  type SideChatSelection,
} from "~/sideChatSelectionStore";
import { askSideChat, closeSideChat } from "~/state/sideChat";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  selectSideChatThreadState,
  useSideChatStore,
  type SideChatExchange,
} from "~/sideChatStore";

/** How close to the bottom the reader must be for a new answer to follow itself down. */
const FOLLOW_TAIL_SLACK_PX = 96;

/** Side chats only fork Claude threads, so the picker never leaves Claude. */
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/**
 * `/clear` is this panel's own command: it resets the transcript rather than
 * reaching the fork, so it shadows the provider's command of the same name.
 */
const CLEAR_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "clear",
  description: "Start this side chat over",
};
const CLEAR_MENU_ITEM_ID = "side-chat-slash:clear";

/**
 * Claude's built-in skills (`/code-review`, `/dataviz`, …) reach the client on
 * the same `slashCommands` list as its session-control commands. The skills run
 * fine inside a fork — the Skill tool is allowed — while the session commands
 * steer a real session and do nothing useful here, so they are dropped.
 */
const SIDE_CHAT_BLOCKED_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "add-dir",
  "agents",
  "btw",
  "bug",
  "chrome",
  "clear",
  "color",
  "compact",
  "config",
  "context",
  "cost",
  "desktop",
  "doctor",
  "exit",
  "export",
  "fork",
  "help",
  "hooks",
  "ide",
  "insights",
  "install-github-app",
  "keybindings",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "output-style",
  "passes",
  "permissions",
  "plugin",
  "privacy-settings",
  "quit",
  "release-notes",
  "resume",
  "rewind",
  "share",
  "statusline",
  "stats",
  "status",
  "tasks",
  "teleport",
  "terminal-setup",
  "theme",
  "todos",
  "upgrade",
  "usage",
  "vim",
]);

function isSideChatSlashCommand(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0 || normalized.startsWith("mcp__")) return false;
  return !SIDE_CHAT_BLOCKED_SLASH_COMMANDS.has(normalized);
}

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const EMPTY_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [];
const EMPTY_MODELS: ReadonlyArray<ServerProviderModel> = [];
const EMPTY_TERMINAL_CONTEXTS = [] as const;

export function describeSideChatFailure(error: unknown): {
  readonly error: string;
  readonly unsupportedProvider: boolean;
} {
  const unsupportedProvider =
    typeof error === "object" &&
    error !== null &&
    (error as { unsupportedProvider?: unknown }).unsupportedProvider === true;
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "The side chat request failed.";
  return { error: message, unsupportedProvider };
}

/**
 * Drops the server-side pending upload and the preview blob for images the side
 * composer is done with. Only ever called once the ask has read them.
 */
function releaseStagedImages(images: ReadonlyArray<ComposerImageAttachment>): void {
  for (const image of images) {
    releaseAttachmentUpload(image.id);
    URL.revokeObjectURL(image.previewUrl);
  }
}

const SELECTION_TOOLTIP_MAX_CHARS = 240;

/** Keeps a chip's tooltip readable when the reader highlighted a whole section. */
function previewSideChatQuote(quote: string): string {
  return quote.length <= SELECTION_TOOLTIP_MAX_CHARS
    ? quote
    : `${quote.slice(0, SELECTION_TOOLTIP_MAX_CHARS)}…`;
}

/** A side question always needs words; images alone get a default one. */
function buildSideChatQuestion(
  typed: string,
  selections: ReadonlyArray<SideChatSelection>,
  hasImages: boolean,
): string {
  const quoted = formatSideChatSelectionsForPrompt(selections);
  if (quoted.length > 0) {
    return [quoted, typed.length > 0 ? typed : "Explain the selected text."].join("\n\n");
  }
  if (typed.length > 0) return typed;
  return hasImages ? "Describe the attached image." : "";
}

/** Mirrors the main composer: a replacement that ends in a space eats the next one. */
function extendReplacementRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string,
): number {
  if (!replacement.endsWith(" ")) return rangeEnd;
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
}

function SideChatExchangeView({
  exchange,
  cwd,
  threadRef,
}: {
  exchange: SideChatExchange;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const answerRef = useRef<HTMLDivElement | null>(null);
  return (
    <li className="flex flex-col gap-2">
      <div className="self-end max-w-[85%] rounded-lg bg-accent px-3 py-1.5 text-sm whitespace-pre-wrap">
        {exchange.prompt}
      </div>
      {exchange.status === "error" ? (
        <p
          className={cn(
            "text-sm",
            exchange.unsupportedProvider
              ? "rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 font-medium text-destructive-foreground"
              : "text-destructive-foreground",
          )}
        >
          {exchange.error ?? "The side chat request failed."}
        </p>
      ) : exchange.answer.length > 0 ? (
        <div ref={answerRef} className="relative min-w-0">
          {exchange.status === "done" ? (
            <AssistantReplyComments
              messageId={`side-chat:${exchange.id}`}
              threadRef={threadRef}
              containerRef={answerRef}
              messageText={exchange.answer}
              origin="side-chat"
            />
          ) : null}
          <ChatMarkdown text={exchange.answer} cwd={cwd} threadRef={threadRef} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Thinking…</p>
      )}
    </li>
  );
}

export function SideChatPanel({
  threadRef,
  cwd,
  providerStatuses,
  settings,
  resolvedTheme,
  threadModelSelection,
  supportsAttachmentUploads,
  worktreePath,
  branch,
  showCheckoutStatus,
}: {
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  providerStatuses: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  resolvedTheme: "light" | "dark";
  /** The thread's own selection, which the side chat starts out following. */
  threadModelSelection: ModelSelection | null | undefined;
  /** Images can only be attached where the environment stores uploads. */
  supportsAttachmentUploads: boolean;
  /** Mirrors the main composer's checkout row; read-only here. */
  worktreePath: string | null;
  branch: string | null;
  showCheckoutStatus: boolean;
}) {
  const threadState = useSideChatStore((state) =>
    selectSideChatThreadState(state.byThreadKey, threadRef),
  );
  const runAsk = useAtomCommand(askSideChat, { reportFailure: false });
  const runClose = useAtomCommand(closeSideChat, { reportFailure: false, reportDefect: false });
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [images, setImages] = useState<ReadonlyArray<ComposerImageAttachment>>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const stopRef = useRef<(() => void) | null>(null);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  const { exchanges, pendingAsk, modelSelection: pickedSelection, usage } = threadState;
  const streaming = exchanges.some((exchange) => exchange.status === "streaming");

  const selections = useSideChatSelectionStore((state) =>
    selectSideChatSelections(state, threadRef),
  );

  /**
   * The fork's own context window, shaped like the main composer's snapshot so
   * `ContextWindowMeter` renders identically. A side chat never auto-compacts,
   * so the compaction affordances stay off.
   */
  const contextWindow = useMemo<ContextWindowSnapshot | null>(() => {
    if (!usage) return null;
    const { maxTokens, usedTokens } = usage;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      maxTokens,
      remainingTokens: maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null,
      usedPercentage,
      remainingPercentage: usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null,
      compactsAutomatically: false,
      updatedAt: usage.updatedAt,
    };
  }, [usage]);

  // ------------------------------------------------------------------
  // Model, effort, and the Claude instance they belong to
  // ------------------------------------------------------------------
  const claudeInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ).filter((entry) => entry.driverKind === CLAUDE_DRIVER_KIND),
    [providerStatuses, settings],
  );

  const selectedInstanceId = useMemo<ProviderInstanceId | null>(() => {
    for (const candidate of [pickedSelection?.instanceId, threadModelSelection?.instanceId]) {
      if (!candidate) continue;
      const match = claudeInstanceEntries.find(
        (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
      );
      if (match) return match.instanceId;
    }
    return (
      resolveSelectableProviderInstanceEntry(claudeInstanceEntries, undefined)?.instanceId ?? null
    );
  }, [claudeInstanceEntries, pickedSelection?.instanceId, threadModelSelection?.instanceId]);

  const selectedEntry = useMemo(
    () => claudeInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId) ?? null,
    [claudeInstanceEntries, selectedInstanceId],
  );

  // A selection only speaks for the instance it was made on; switching
  // instances falls back to that instance's own first model.
  const preferredModel = useMemo<string | null>(() => {
    if (pickedSelection && pickedSelection.instanceId === selectedInstanceId) {
      return pickedSelection.model;
    }
    if (threadModelSelection && threadModelSelection.instanceId === selectedInstanceId) {
      return threadModelSelection.model;
    }
    return null;
  }, [pickedSelection, selectedInstanceId, threadModelSelection]);

  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of claudeInstanceEntries) {
      out.set(
        entry.instanceId,
        getAppModelOptionsForInstance(
          settings,
          entry,
          entry.instanceId === selectedInstanceId ? preferredModel : null,
        ),
      );
    }
    return out;
  }, [claudeInstanceEntries, preferredModel, selectedInstanceId, settings]);

  const selectedModel =
    preferredModel ??
    (selectedInstanceId ? (modelOptionsByInstance.get(selectedInstanceId)?.[0]?.slug ?? "") : "");

  const activeModelOptions = useMemo<ReadonlyArray<ProviderOptionSelection> | undefined>(() => {
    if (pickedSelection) return pickedSelection.options;
    if (threadModelSelection && threadModelSelection.instanceId === selectedInstanceId) {
      return threadModelSelection.options;
    }
    return undefined;
  }, [pickedSelection, selectedInstanceId, threadModelSelection]);

  const selectedModels = selectedEntry?.models ?? EMPTY_MODELS;
  const skills = selectedEntry?.snapshot.skills ?? EMPTY_SKILLS;
  const slashCommands = selectedEntry?.snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS;

  const providerState = useMemo(
    () =>
      getComposerProviderState({
        provider: CLAUDE_DRIVER_KIND,
        model: selectedModel,
        models: selectedModels,
        promptInjectionState: getComposerPromptInjectionState(prompt),
        modelOptions: activeModelOptions,
        planModeEnabled: settings.planModeEnabled,
      }),
    [activeModelOptions, prompt, selectedModel, selectedModels, settings.planModeEnabled],
  );

  const askModelSelection = useMemo<ModelSelection | undefined>(() => {
    if (!selectedInstanceId || selectedModel.length === 0) return undefined;
    return createModelSelection(
      selectedInstanceId,
      selectedModel,
      providerState.modelOptionsForDispatch,
    );
  }, [providerState.modelOptionsForDispatch, selectedInstanceId, selectedModel]);
  const askModelSelectionRef = useRef(askModelSelection);
  askModelSelectionRef.current = askModelSelection;

  // ------------------------------------------------------------------
  // Asking
  // ------------------------------------------------------------------
  const ask = useCallback(
    async (question: string, staged: ReadonlyArray<ComposerImageAttachment>) => {
      const trimmed = question.trim();
      if (trimmed.length === 0 || stopRef.current !== null) return;
      const store = useSideChatStore.getState();
      const sideChatId = store.ensureSideChat(threadRef);
      const exchangeId = store.appendExchange(threadRef, trimmed);

      // Images ride the same upload queue as a main turn; the ask carries the
      // ids the server can resolve to files.
      let attachments: ReadonlyArray<ChatImageAttachment> = [];
      if (staged.length > 0) {
        await awaitAttachmentUploads(staged.map((image) => image.id));
        const uploaded = getUploadedAttachments({
          environmentId: threadRef.environmentId,
          images: [...staged],
        })?.filter(
          (attachment): attachment is ChatImageAttachment => attachment.type === "image",
        );
        if (!uploaded || uploaded.length !== staged.length) {
          useSideChatStore.getState().failExchange(threadRef, exchangeId, {
            error: "Retry or remove failed uploads before sending.",
            unsupportedProvider: false,
          });
          releaseStagedImages(staged);
          return;
        }
        attachments = uploaded;
      }

      let stopped = false;
      let signalStop = () => {};
      const stop = new Promise<void>((resolve) => {
        signalStop = () => {
          stopped = true;
          resolve();
        };
      });
      stopRef.current = signalStop;
      const selection = askModelSelectionRef.current;
      const result = await runAsk({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        sideChatId,
        prompt: trimmed,
        ...(selection ? { modelSelection: selection } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        onEvent: (event) => {
          if (event.type === "delta") {
            useSideChatStore.getState().appendAnswer(threadRef, exchangeId, event.text);
          } else if (event.type === "complete") {
            useSideChatStore.getState().completeExchange(threadRef, exchangeId, event.text);
          } else if (event.type === "usage") {
            useSideChatStore.getState().setUsage(threadRef, {
              usedTokens: event.usedTokens,
              maxTokens: event.maxTokens ?? null,
            });
          }
        },
        stop,
      });
      if (stopRef.current === signalStop) stopRef.current = null;
      // The server has read the bytes by now, so the pending copies can go.
      releaseStagedImages(staged);
      if (stopped || result._tag === "Success" || isAtomCommandInterrupted(result)) {
        useSideChatStore.getState().settleExchange(threadRef, exchangeId);
        return;
      }
      const failure = describeSideChatFailure(squashAtomCommandFailure(result));
      useSideChatStore.getState().failExchange(threadRef, exchangeId, failure);
    },
    [runAsk, threadRef],
  );

  // ------------------------------------------------------------------
  // Composer text
  // ------------------------------------------------------------------
  /** Writes a new prompt through every piece of state the editor reads back. */
  const applyPromptValue = useCallback((nextText: string, expandedCursor: number) => {
    const nextCursor = collapseExpandedComposerCursor(nextText, expandedCursor);
    promptRef.current = nextText;
    setPrompt(nextText);
    setCursor(nextCursor);
    setTrigger(
      detectComposerTrigger(nextText, expandCollapsedComposerCursor(nextText, nextCursor)),
    );
    return nextCursor;
  }, []);

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setCursor(nextCursor);
      setTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [],
  );

  /** The traits menu rewrites the prompt when effort is prompt-injected. */
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const nextCursor = applyPromptValue(nextPrompt, nextPrompt.length);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
    },
    [applyPromptValue],
  );

  // A `/btw` prompt is handed over through the store, so the main composer does
  // not have to wait for this panel to exist before it can hand the question off.
  const handledAskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingAsk === null || handledAskIdRef.current === pendingAsk.id) return;
    handledAskIdRef.current = pendingAsk.id;
    useSideChatStore.getState().clearPendingAsk(threadRef);
    // `/btw <text>` lands in the side chat composer for review; it is not sent.
    if (pendingAsk.prompt.length > 0) {
      const nextCursor = applyPromptValue(pendingAsk.prompt, pendingAsk.prompt.length);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
    }
  }, [applyPromptValue, pendingAsk, threadRef]);

  const lastExchange = exchanges.at(-1);
  const tailLength = lastExchange ? lastExchange.answer.length : 0;
  useEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > FOLLOW_TAIL_SLACK_PX) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [exchanges.length, tailLength]);

  // Clearing drops the fork on the server too, then forks again on the next
  // question: the point is a transcript the reader can start over from.
  const clear = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    const { sideChatId } = selectSideChatThreadState(
      useSideChatStore.getState().byThreadKey,
      threadRef,
    );
    if (sideChatId.length > 0) {
      void runClose({ environmentId: threadRef.environmentId, sideChatId });
    }
    releaseStagedImages(imagesRef.current);
    setImages([]);
    useSideChatSelectionStore.getState().clear(threadRef);
    useSideChatStore.getState().reset(threadRef);
  }, [runClose, threadRef]);

  // ------------------------------------------------------------------
  // Image attachments
  // ------------------------------------------------------------------
  /** Stages images the same way the main composer does: compress, then upload. */
  const addImages = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (!supportsAttachmentUploads) return;
      const candidates = files
        .map(normalizeComposerImageFileMimeType)
        .filter((file) => classifyComposerAttachmentFile(file) === "image")
        .slice(0, Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - imagesRef.current.length));
      if (candidates.length === 0) return;

      const staged: ComposerImageAttachment[] = [];
      for (const file of candidates) {
        // Oversized images are downscaled to fit rather than refused.
        const compressed = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
        if (!compressed.ok) continue;
        const attachmentFile = compressed.file;
        staged.push({
          type: "image",
          id: randomUUID(),
          name: attachmentFile.name || "image",
          mimeType: attachmentFile.type,
          sizeBytes: attachmentFile.size,
          previewUrl: URL.createObjectURL(attachmentFile),
          file: attachmentFile,
        });
      }
      if (staged.length === 0) return;
      for (const image of staged) {
        startAttachmentUpload({ environmentId: threadRef.environmentId, image });
      }
      setImages((current) => [...current, ...staged]);
    },
    [supportsAttachmentUploads, threadRef.environmentId],
  );

  const removeImage = useCallback((imageId: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (!removed) return current;
      releaseStagedImages([removed]);
      return current.filter((image) => image.id !== imageId);
    });
  }, []);

  const onComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (
        files.length === 0 ||
        !supportsAttachmentUploads ||
        !shouldHandleComposerAttachmentPaste({
          files,
          plainText: event.clipboardData.getData("text/plain"),
        })
      ) {
        return;
      }
      event.preventDefault();
      void addImages(files);
    },
    [addImages, supportsAttachmentUploads],
  );

  // Staged images that never got sent still own a server-side pending upload.
  useEffect(
    () => () => {
      releaseStagedImages(imagesRef.current);
    },
    [],
  );

  const submit = useCallback(() => {
    if (streaming) return;
    const staged = imagesRef.current;
    const currentSelections = selectSideChatSelections(
      useSideChatSelectionStore.getState(),
      threadRef,
    );
    const question = buildSideChatQuestion(
      promptRef.current.trim(),
      currentSelections,
      staged.length > 0,
    );
    if (question.length === 0) return;
    applyPromptValue("", 0);
    setImages([]);
    useSideChatSelectionStore.getState().clear(threadRef);
    void ask(question, staged);
  }, [applyPromptValue, ask, streaming, threadRef]);

  // ------------------------------------------------------------------
  // Mention / skill / slash menu
  // ------------------------------------------------------------------
  const pathQuery = trigger?.kind === "path" ? trigger.query : null;
  const workspaceEntries = useComposerPathSearch({
    environmentId: threadRef.environmentId,
    cwd: pathQuery === null ? null : (cwd ?? null),
    query: pathQuery,
  });

  const menuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "path") {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (trigger.kind === "skill") {
      return searchProviderSkills(skills, trigger.query).map((skill) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        provider: CLAUDE_DRIVER_KIND,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Use this skill"),
      }));
    }
    // Slash commands only mean anything at the very start of a question.
    if (trigger.rangeStart !== 0) return [];
    return searchSlashCommandItems(
      [
        {
          id: CLEAR_MENU_ITEM_ID,
          type: "provider-slash-command" as const,
          provider: CLAUDE_DRIVER_KIND,
          command: CLEAR_SLASH_COMMAND,
          label: "/clear",
          description: CLEAR_SLASH_COMMAND.description ?? "",
        },
        ...slashCommands
          .filter((command) => isSideChatSlashCommand(command.name))
          .map((command) => ({
            id: `side-chat-slash:${command.name}`,
            type: "provider-slash-command" as const,
            provider: CLAUDE_DRIVER_KIND,
            command,
            label: `/${command.name}`,
            description: command.description ?? command.input?.hint ?? "Run provider command",
          })),
      ],
      trigger.query,
    );
  }, [skills, slashCommands, trigger, workspaceEntries.entries]);

  const menuOpen = trigger !== null;
  const menuSearchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const activeMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: menuItems,
      highlightedItemId,
      currentSearchKey: menuSearchKey,
      highlightedSearchKey,
    });
    return menuItems.find((item) => item.id === activeItemId) ?? null;
  }, [highlightedItemId, highlightedSearchKey, menuItems, menuSearchKey]);

  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const menuItemsRef = useRef(menuItems);
  menuItemsRef.current = menuItems;
  const activeMenuItemRef = useRef(activeMenuItem);
  activeMenuItemRef.current = activeMenuItem;
  const highlightedItemIdRef = useRef(highlightedItemId);
  highlightedItemIdRef.current = highlightedItemId;

  const onMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setHighlightedItemId(itemId);
      setHighlightedSearchKey(menuSearchKey);
    },
    [menuSearchKey],
  );

  const onSelectMenuItem = useCallback(
    (item: ComposerCommandItem) => {
      // `/clear` is the panel's own command, so it runs instead of being typed.
      if (item.id === CLEAR_MENU_ITEM_ID) {
        applyPromptValue("", 0);
        setHighlightedItemId(null);
        clear();
        return;
      }
      const snapshot = editorRef.current?.readSnapshot();
      const text = snapshot?.value ?? promptRef.current;
      const expandedCursor =
        snapshot?.expandedCursor ?? expandCollapsedComposerCursor(text, cursor);
      const activeTrigger = detectComposerTrigger(text, expandedCursor);
      if (!activeTrigger) return;
      const replacement =
        item.type === "path"
          ? `${serializeComposerFileLink(item.path)} `
          : item.type === "skill"
            ? `$${item.skill.name} `
            : item.type === "provider-slash-command"
              ? `/${item.command.name} `
              : "";
      if (replacement.length === 0) return;
      const rangeEnd = extendReplacementRangeForTrailingSpace(
        text,
        activeTrigger.rangeEnd,
        replacement,
      );
      const next = replaceTextRange(text, activeTrigger.rangeStart, rangeEnd, replacement);
      const nextCursor = applyPromptValue(next.text, next.cursor);
      setHighlightedItemId(null);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
    },
    [applyPromptValue, clear, cursor],
  );

  const nudgeMenuHighlight = useCallback((key: "ArrowDown" | "ArrowUp") => {
    const items = menuItemsRef.current;
    if (items.length === 0) return;
    const highlightedIndex = items.findIndex(
      (item) => item.id === highlightedItemIdRef.current,
    );
    const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
    const offset = key === "ArrowDown" ? 1 : -1;
    const nextIndex = (normalizedIndex + offset + items.length) % items.length;
    setHighlightedItemId(items[nextIndex]?.id ?? null);
  }, []);

  const onCommandKeyDown = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab", event: KeyboardEvent) => {
      const snapshot = editorRef.current?.readSnapshot();
      const activeTrigger = snapshot
        ? detectComposerTrigger(snapshot.value, snapshot.expandedCursor)
        : null;
      if (menuOpenRef.current || activeTrigger !== null) {
        const items = menuItemsRef.current;
        const selected = activeMenuItemRef.current ?? items[0];
        if ((key === "ArrowDown" || key === "ArrowUp") && items.length > 0) {
          nudgeMenuHighlight(key);
          return true;
        }
        if ((key === "Enter" || key === "Tab") && selected) {
          onSelectMenuItem(selected);
          return true;
        }
      }
      // Shift+Enter falls through to Lexical, which inserts the newline.
      if (key === "Enter" && !event.shiftKey) {
        submit();
        return true;
      }
      return false;
    },
    [nudgeMenuHighlight, onSelectMenuItem, submit],
  );

  const menuEmptyStateText =
    trigger?.kind === "skill"
      ? "No skills found."
      : trigger?.kind === "path"
        ? "No matching files or folders."
        : "No commands found.";

  // ------------------------------------------------------------------
  // Footer controls
  // ------------------------------------------------------------------
  const setModelSelection = useSideChatStore((state) => state.setModelSelection);
  const traitsVisible =
    selectedModel.length > 0 &&
    shouldRenderTraitsControls({
      provider: CLAUDE_DRIVER_KIND,
      models: selectedModels,
      model: selectedModel,
      prompt,
      modelOptions: activeModelOptions,
      planModeEnabled: settings.planModeEnabled,
    });

  const onModelOptionsChange = useCallback(
    (nextOptions: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      if (!selectedInstanceId || selectedModel.length === 0) return;
      setModelSelection(
        threadRef,
        createModelSelection(selectedInstanceId, selectedModel, nextOptions),
      );
    },
    [selectedInstanceId, selectedModel, setModelSelection, threadRef],
  );

  const hasSendableContent =
    prompt.trim().length > 0 || selections.length > 0 || images.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        Asks about this conversation without adding to it. Read-only tools.
      </p>
      {exchanges.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <MessagesSquare aria-hidden className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">Ask on the side</p>
          <p className="max-w-56 text-xs text-muted-foreground">
            Questions here fork the thread's conversation. Nothing you ask lands in the agent's
            context.
          </p>
        </div>
      ) : (
        <ScrollArea ref={scrollRootRef} className="min-h-0 flex-1">
          <ul className="flex flex-col gap-4 p-3">
            {exchanges.map((exchange) => (
              <SideChatExchangeView
                key={exchange.id}
                exchange={exchange}
                cwd={cwd}
                threadRef={threadRef}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
      <div className="shrink-0 px-2 pt-1 pb-2">
        <ComposerSurface.Shell contextStrip={showCheckoutStatus}>
          <ComposerSurface.Host>
            <form
              data-chat-composer-form="true"
              className="w-full min-w-0"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
              onDragOver={(event) => {
                if (!supportsAttachmentUploads) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                const files = Array.from(event.dataTransfer.files);
                if (!supportsAttachmentUploads || files.length === 0) return;
                event.preventDefault();
                void addImages(files);
              }}
            >
              <ComposerSurface.Main>
                <div className="rounded-[20px]">
                  {selections.length > 0 || images.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1 px-3 pt-3 text-[12px]">
                      {selections.map((selection, index) => (
                        <Tooltip key={selection.id}>
                          <TooltipTrigger
                            render={<span className={COMPOSER_INLINE_CHIP_CLASS_NAME} />}
                          >
                            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
                              Selection {index + 1}
                            </span>
                            <button
                              type="button"
                              aria-label={`Remove selection ${index + 1}`}
                              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
                              onClick={() =>
                                useSideChatSelectionStore.getState().remove(threadRef, selection.id)
                              }
                            >
                              <XIcon aria-hidden className="size-[0.86em]" />
                            </button>
                          </TooltipTrigger>
                          <TooltipPopup side="top" className="max-w-72">
                            <span className="block whitespace-pre-wrap">
                              {previewSideChatQuote(selection.quote)}
                            </span>
                          </TooltipPopup>
                        </Tooltip>
                      ))}
                      {images.map((image) => (
                        <span key={image.id} className={COMPOSER_INLINE_CHIP_CLASS_NAME}>
                          <img
                            src={image.previewUrl}
                            alt=""
                            className="size-[1.17em] shrink-0 rounded-[0.25em] object-cover"
                          />
                          <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
                            {image.name}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${image.name}`}
                            className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
                            onClick={() => removeImage(image.id)}
                          >
                            <XIcon aria-hidden className="size-[0.86em]" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div ref={setMenuAnchor} className="relative px-3 pt-3 pb-1.5">
                    {menuOpen ? (
                      <ComposerCommandMenuLayer anchor={menuAnchor}>
                        <ComposerCommandMenu
                          items={menuItems}
                          resolvedTheme={resolvedTheme}
                          isLoading={pathQuery !== null && workspaceEntries.isPending}
                          triggerKind={trigger?.kind ?? null}
                          emptyStateText={menuEmptyStateText}
                          activeItemId={activeMenuItem?.id ?? null}
                          onHighlightedItemChange={onMenuItemHighlighted}
                          onSelect={onSelectMenuItem}
                        />
                      </ComposerCommandMenuLayer>
                    ) : null}
                    <ComposerPromptEditor
                      editorRef={editorRef}
                      value={prompt}
                      cursor={cursor}
                      terminalContexts={EMPTY_TERMINAL_CONTEXTS}
                      skills={skills}
                      className="min-h-12 max-h-40"
                      disabled={false}
                      placeholder="Ask about this conversation, @tag files, $use skills"
                      onRemoveTerminalContext={() => {}}
                      onChange={onPromptChange}
                      onCommandKeyDown={onCommandKeyDown}
                      onPaste={onComposerPaste}
                    />
                  </div>
                  <div className="flex min-w-0 flex-nowrap items-center justify-between gap-1.5 px-3 pb-3">
                    <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {selectedInstanceId ? (
                        <ProviderModelPicker
                          compact
                          activeInstanceId={selectedInstanceId}
                          model={selectedModel}
                          lockedProvider={CLAUDE_DRIVER_KIND}
                          instanceEntries={claudeInstanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          triggerClassName="-ms-2.5"
                          triggerAriaLabel="Side chat model"
                          onInstanceModelChange={(instanceId, model) => {
                            setModelSelection(threadRef, createModelSelection(instanceId, model));
                          }}
                        />
                      ) : null}
                      {traitsVisible ? (
                        <TraitsPicker
                          provider={CLAUDE_DRIVER_KIND}
                          {...(selectedInstanceId ? { instanceId: selectedInstanceId } : {})}
                          models={selectedModels}
                          model={selectedModel}
                          prompt={prompt}
                          onPromptChange={setPromptFromTraits}
                          modelOptions={activeModelOptions}
                          planModeEnabled={settings.planModeEnabled}
                          onModelOptionsChange={onModelOptionsChange}
                        />
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                      {supportsAttachmentUploads ? (
                        <>
                          <input
                            ref={attachmentInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                              const files = Array.from(event.currentTarget.files ?? []);
                              event.currentTarget.value = "";
                              void addImages(files);
                            }}
                          />
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onPointerDown={(event) => event.preventDefault()}
                                  onClick={() => attachmentInputRef.current?.click()}
                                  aria-label="Attach images"
                                />
                              }
                            >
                              <PaperclipIcon />
                            </TooltipTrigger>
                            <TooltipPopup>Attach images</TooltipPopup>
                          </Tooltip>
                        </>
                      ) : null}
                      {contextWindow ? <ContextWindowMeter usage={contextWindow} /> : null}
                      <ComposerPrimaryActions
                        compact
                        pendingAction={null}
                        isRunning={streaming}
                        showPlanFollowUpPrompt={false}
                        promptHasText={hasSendableContent}
                        isSendBusy={false}
                        sendDisabledReason={null}
                        isConnecting={false}
                        isEnvironmentUnavailable={selectedInstanceId === null}
                        isPreparingWorktree={false}
                        hasSendableContent={hasSendableContent}
                        onPreviousPendingQuestion={() => {}}
                        onInterrupt={() => {
                          stopRef.current?.();
                          stopRef.current = null;
                        }}
                        onImplementPlanInNewThread={() => {}}
                      />
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </form>
          </ComposerSurface.Host>
          {showCheckoutStatus ? (
            <ComposerSurface.ContextStrip>
              <span
                className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs"
                data-composer-context-control
              >
                {worktreePath ? (
                  <FolderGitIcon aria-hidden className="size-3 shrink-0" />
                ) : (
                  <FolderIcon aria-hidden className="size-3 shrink-0" />
                )}
                <span className="min-w-0 truncate">{resolveLockedWorkspaceLabel(worktreePath)}</span>
              </span>
              {branch ? (
                <span
                  className="ms-auto inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs"
                  data-composer-context-control
                >
                  <GitBranchIcon aria-hidden className="size-3 shrink-0 opacity-70" />
                  <span className="min-w-0 truncate">{branch}</span>
                </span>
              ) : null}
            </ComposerSurface.ContextStrip>
          ) : null}
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}
