import type { z } from "zod";
import {
  DEFAULT_COMPACTION_SYSTEM_PROMPT,
  DEFAULT_COMPACTION_THRESHOLD,
  defaultCompactionStrategy,
  estimateTokens,
  shouldCompact,
} from "./context.ts";
import { createEventEmitter, type EventHandler } from "./events.ts";
import type { LLMProviderWithModel, ModelInfo } from "./llm.ts";
import { toLLMMessages } from "./llm.ts";
import { processTurn } from "./processor.ts";
import { ToolRegistry, buildToolMap, toLLMTool } from "./tool/registry.ts";
import { FileMutationQueue } from "./tool/queue.ts";
import type {
  AfterToolCallHook,
  BeforeBranchHook,
  BeforeCompactionHook,
  BeforeInputHook,
  BeforeLLMCallHook,
  BeforePromptHook,
  BeforeToolCallHook,
  CompactionContext,
  CompactionOptions,
  CompactionReason,
  ContextTransform,
  ToolDef,
} from "./tool/types.ts";
import {
  AgentError,
  type AssistantMessage,
  type Message,
  type ModelRef,
  type UserPart,
} from "./types.ts";
import { SessionPersistenceAdapter } from "./storage/adapter.ts";
import { MemoryStorage } from "./storage/memory.ts";
import type {
  MetadataBag,
  Session as StorageSession,
  SessionMetadata,
  SessionStorageDriver,
} from "./storage/types.ts";
import { generateId } from "./util/id.ts";

/**
 * Resolves the system prompt for a turn. Evaluated each turn, so it sees the
 * current tool set (after any runtime `setTools`) and the live history. The
 * returned string is used verbatim — core imposes no assembly. Use
 * `buildSystemPrompt` inside the resolver if you want batteries-included
 * assembly.
 */
export type SystemPromptResolver = (ctx: {
  tools: ToolDef[];
  messages: Message[];
  model: ModelInfo;
}) => string | Promise<string>;

export interface SessionOptions<TMeta extends MetadataBag = MetadataBag> {
  sessionId?: string;
  llm: LLMProviderWithModel;
  tools?: ToolDef[];
  /** Static base prompt, or a resolver evaluated each turn. Used verbatim. */
  systemPrompt?: string | SystemPromptResolver;
  /** Step budget for a single prompt. Unbounded when omitted. */
  maxSteps?: number;
  maxOutputChars?: number;
  toolExecution?: "parallel" | "sequential";
  transformContext?: ContextTransform;
  beforeInput?: BeforeInputHook;
  beforeBranch?: BeforeBranchHook;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
  beforeLLMCall?: BeforeLLMCallHook;
  beforePrompt?: BeforePromptHook;
  onEvent?: EventHandler;
  retry?: { maxAttempts?: number; maxDelayMs?: number };
  compaction?: false | CompactionOptions;
  beforeCompaction?: BeforeCompactionHook;
  storage?: SessionStorageDriver;
  /** Opaque, host-owned per-session JSON. Persisted at create, readable on load. */
  metadata?: TMeta;
  /**
   * Reattach to an existing `sessionId` instead of creating a new row. Requires
   * `sessionId`. Pair with `seedMessages` (e.g. from `readSession`) to seed the
   * in-memory history; turns keep appending from the stored sequence.
   */
  attach?: boolean;
  /** Messages to seed in-memory history with when attaching. */
  seedMessages?: Message[];
}

export interface BranchOptions {
  sessionId?: string;
}

/**
 * Plain stored session data: the host's opaque metadata, the prompt-visible
 * message history, and lineage. Returned by `readSession`; drop it into
 * `createSession({ attach: true, seedMessages })` with your own config.
 */
export interface LoadedSession<TMeta extends MetadataBag = MetadataBag> {
  metadata: TMeta | undefined;
  messages: Message[];
  parentSessionId: string | undefined;
  branchedFromMessageId: string | undefined;
}

export interface SessionInfo<TMeta extends MetadataBag = MetadataBag> {
  id: string;
  parentSessionId: string | undefined;
  branchedFromMessageId: string | undefined;
  createdAt: number;
  updatedAt: number;
  metadata: TMeta | undefined;
}

export interface Session {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly branchedFromMessageId: string | undefined;
  prompt(input: string | UserPart[]): Promise<AssistantMessage>;
  cancel(): void;
  messages(): Message[];
  branchFrom(messageId: string, options?: BranchOptions): Promise<Session>;
  addTool(tool: ToolDef): void;
  removeTool(id: string): void;
  setTools(tools: ToolDef[]): void;
  getTools(): ToolDef[];
  setBeforeInput(hook: BeforeInputHook | undefined): void;
  setBeforeBranch(hook: BeforeBranchHook | undefined): void;
  setBeforeToolCall(hook: BeforeToolCallHook | undefined): void;
  setAfterToolCall(hook: AfterToolCallHook | undefined): void;
  setTransformContext(transform: ContextTransform | undefined): void;
  setBeforePrompt(hook: BeforePromptHook | undefined): void;
  setBeforeLLMCall(hook: BeforeLLMCallHook | undefined): void;
  setBeforeCompaction(hook: BeforeCompactionHook | undefined): void;
  compact(): Promise<boolean>;
  setLLM(llm: LLMProviderWithModel): void;
  readonly isStreaming: boolean;
  readonly model: ModelInfo;
}

function toMessageModel(model: ModelInfo): ModelRef {
  const parts = model.id.split(":");
  if (parts.length > 1) {
    return { provider: parts[0]!, model: parts.slice(1).join(":") };
  }
  return { provider: "unknown", model: model.id };
}

async function transformForTurn(
  messages: Message[],
  transformContext: ContextTransform | undefined,
  signal: AbortSignal,
): Promise<Message[]> {
  if (!transformContext) {
    return messages;
  }
  return transformContext(messages, signal);
}

interface SessionState {
  sessionId: string;
  messages: Message[];
  parentSessionId?: string;
  branchedFromMessageId?: string;
}

interface ResolvedCompactionOptions {
  threshold: number;
  strategy: (messages: Message[], ctx: CompactionContext) => Promise<Message[]>;
  summarySystemPrompt: string;
}

function resolveCompactionOptions(
  options: false | CompactionOptions | undefined,
): ResolvedCompactionOptions | false {
  if (options === false) {
    return false;
  }
  return {
    threshold: options?.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
    strategy: options?.strategy ?? defaultCompactionStrategy,
    summarySystemPrompt: options?.summarySystemPrompt ?? DEFAULT_COMPACTION_SYSTEM_PROMPT,
  };
}

function makeSessionMetadata(options: {
  sessionId: string;
  metadata?: MetadataBag;
  parentSessionId?: string;
  branchedFromMessageId?: string;
}): SessionMetadata {
  const now = Date.now();
  return {
    id: options.sessionId,
    createdAt: now,
    updatedAt: now,
    parentSessionId: options.parentSessionId,
    branchedFromMessageId: options.branchedFromMessageId,
    metadata: options.metadata,
  };
}

function resolveStorage(storage: SessionStorageDriver | undefined): SessionPersistenceAdapter {
  return new SessionPersistenceAdapter(storage ?? new MemoryStorage());
}

async function initializeSessionState(
  options: SessionOptions,
  storage: SessionPersistenceAdapter,
): Promise<SessionState> {
  if (options.attach) {
    if (!options.sessionId) {
      throw new AgentError("attach requires a sessionId.", "SESSION_NOT_FOUND");
    }
    const existing = await storage.loadSession(options.sessionId);
    if (!existing) {
      throw new AgentError(`Session not found: ${options.sessionId}`, "SESSION_NOT_FOUND");
    }
    const messages = options.seedMessages ?? (await storage.loadVisibleMessages(options.sessionId));
    return {
      sessionId: options.sessionId,
      messages: [...messages],
      parentSessionId: existing.parentSessionId,
      branchedFromMessageId: existing.branchedFromMessageId,
    };
  }

  const sessionId = options.sessionId ?? generateId();
  if (options.sessionId) {
    const existing = await storage.loadSession(sessionId);
    if (existing) {
      throw new AgentError(`Session already exists: ${sessionId}`, "SESSION_EXISTS");
    }
  }

  await storage.createSession(makeSessionMetadata({ sessionId, metadata: options.metadata }));
  return { sessionId, messages: [] };
}

async function createSessionInternal(
  options: SessionOptions,
  seededState?: SessionState,
): Promise<Session> {
  const storage = resolveStorage(options.storage);
  const state = seededState ?? (await initializeSessionState(options, storage));
  const sessionId = state.sessionId;
  let llm = options.llm.llm;
  let model = options.llm.model;
  let beforeInput = options.beforeInput;
  let beforeBranch = options.beforeBranch;
  let beforeToolCall = options.beforeToolCall;
  let afterToolCall = options.afterToolCall;
  let beforeLLMCall = options.beforeLLMCall;
  let beforePrompt = options.beforePrompt;
  let transformContext = options.transformContext;
  let compaction = options.compaction;
  let beforeCompaction = options.beforeCompaction;
  let streaming = false;
  let currentAbort: AbortController | undefined;

  const eventEmitter = createEventEmitter(options.onEvent);
  const queue = new FileMutationQueue();
  let customTools = [...(options.tools ?? [])];
  const currentMessages: Message[] = [...state.messages];
  let compactedDuringTurn = false;
  const registry = new ToolRegistry(customTools);

  const resolveSystemPrompt = async (tools: ToolDef[], messages: Message[]): Promise<string> => {
    const systemPrompt = options.systemPrompt;
    if (systemPrompt === undefined) {
      return "";
    }
    if (typeof systemPrompt === "string") {
      return systemPrompt;
    }
    return await systemPrompt({ tools, messages, model });
  };

  const emitToolsChanged = () =>
    eventEmitter.emit({
      type: "tools.changed",
      tools: registry.list().map((tool) => tool.id),
    });

  const replaceMessageHistory = (messages: Message[]) => {
    currentMessages.splice(0, currentMessages.length, ...messages);
  };

  const compactHistory = async (reason: CompactionReason, signal: AbortSignal) => {
    const resolved = resolveCompactionOptions(compaction);
    if (!resolved) {
      return false;
    }

    const beforeTokens = estimateTokens(currentMessages);

    if (beforeCompaction) {
      const patch = await beforeCompaction({
        sessionId,
        reason,
        messages: [...currentMessages],
        estimatedTokens: beforeTokens,
      });
      if (patch?.cancel) {
        return false;
      }
      if (patch?.messages) {
        const patchTokens = estimateTokens(patch.messages);
        if (patch.messages.length === 0 || patchTokens >= beforeTokens) {
          throw new AgentError(
            "Compaction did not reduce the session history.",
            "COMPACTION_FAILED",
          );
        }
        replaceMessageHistory(patch.messages);
        compactedDuringTurn = true;
        eventEmitter.emit({ type: "compaction", before: beforeTokens, after: patchTokens });
        return true;
      }
    }

    const compacted = await resolved.strategy([...currentMessages], {
      sessionId,
      llm,
      model,
      signal,
      reason,
      retry: options.retry,
      summarySystemPrompt: resolved.summarySystemPrompt,
    });
    const afterTokens = estimateTokens(compacted);

    if (compacted.length === 0 || afterTokens >= beforeTokens) {
      throw new AgentError("Compaction did not reduce the session history.", "COMPACTION_FAILED");
    }

    replaceMessageHistory(compacted);
    compactedDuringTurn = true;
    eventEmitter.emit({ type: "compaction", before: beforeTokens, after: afterTokens });
    return true;
  };

  const session: Session = {
    get id() {
      return sessionId;
    },
    get parentId() {
      return state.parentSessionId;
    },
    get branchedFromMessageId() {
      return state.branchedFromMessageId;
    },
    async prompt(input) {
      if (streaming) {
        throw new AgentError("Session is already streaming.", "SESSION_BUSY");
      }

      if (beforeInput) {
        const patch = await beforeInput({ input, sessionId });
        if (patch?.reject) {
          throw new AgentError(patch.reason ?? "Input rejected.", "INPUT_REJECTED");
        }
        if (patch?.input !== undefined) {
          input = patch.input;
        }
      }

      const userMessage: Message = {
        id: generateId(),
        role: "user",
        parts: typeof input === "string" ? [{ type: "text", text: input }] : input,
        model: toMessageModel(model),
      };

      const { turn } = await storage.startTurn({ sessionId, userMessage });
      currentMessages.push(userMessage);
      eventEmitter.emit({ type: "message.created", message: userMessage });

      streaming = true;
      currentAbort = new AbortController();
      eventEmitter.emit({ type: "turn.start", sessionId, messageId: userMessage.id });
      let compactionAttempts = 0;
      let steps = 0;
      let turnStatus: "completed" | "failed" = "completed";
      compactedDuringTurn = false;

      try {
        while (true) {
          const activeTools = registry.list();

          const resolvedCompaction = resolveCompactionOptions(compaction);
          if (
            resolvedCompaction &&
            shouldCompact(currentMessages, model.contextLimit, resolvedCompaction.threshold)
          ) {
            compactionAttempts += 1;
            if (compactionAttempts > 3) {
              throw new AgentError(
                "Compaction exceeded the maximum attempts for this prompt.",
                "COMPACTION_FAILED",
              );
            }
            const didCompact = await compactHistory("proactive", currentAbort.signal);
            if (didCompact) {
              continue;
            }
          }

          const transformedMessages = await transformForTurn(
            currentMessages,
            transformContext,
            currentAbort.signal,
          );

          const baseSystemPrompt = await resolveSystemPrompt(activeTools, transformedMessages);

          const promptPatch = await beforePrompt?.({
            systemPrompt: baseSystemPrompt,
            messages: transformedMessages,
            tools: activeTools,
          });
          const turnMessages = [...transformedMessages, ...(promptPatch?.injectedMessages ?? [])];

          const assistant = await processTurn({
            llm,
            system: promptPatch?.systemPrompt ?? baseSystemPrompt,
            messages: toLLMMessages(turnMessages),
            tools: activeTools.map(toLLMTool),
            toolMap: buildToolMap(activeTools),
            sessionId: session.id,
            model: toMessageModel(model),
            abort: currentAbort.signal,
            emit: eventEmitter.emit,
            queue,
            beforeToolCall,
            afterToolCall,
            beforeLLMCall,
            toolExecution: options.toolExecution,
            maxOutputChars: options.maxOutputChars,
            retry: options.retry,
          });

          if (assistant.error?.code === "CONTEXT_OVERFLOW" && resolvedCompaction) {
            compactionAttempts += 1;
            if (compactionAttempts <= 3) {
              await compactHistory("reactive", currentAbort.signal);
              continue;
            }
          }

          await storage.appendAssistantMessage({
            sessionId,
            turnId: turn.id,
            message: assistant,
          });
          currentMessages.push(assistant);
          eventEmitter.emit({ type: "message.created", message: assistant });

          if (assistant.error) {
            turnStatus = "failed";
          }

          if (assistant.finishReason !== "tool-calls") {
            eventEmitter.emit({ type: "done", message: assistant });
            return assistant;
          }

          steps++;
          if (options.maxSteps !== undefined && steps >= options.maxSteps) {
            assistant.error = new AgentError("Step budget exhausted.", "MAX_STEPS");
            turnStatus = "failed";
            eventEmitter.emit({ type: "done", message: assistant });
            return assistant;
          }
        }
      } catch (error) {
        turnStatus = "failed";
        throw error;
      } finally {
        await storage.completeTurn({ sessionId, turnId: turn.id, status: turnStatus });
        if (compactedDuringTurn) {
          await storage.writeCompactionHistorySnapshot(sessionId, [...currentMessages]);
          compactedDuringTurn = false;
        }
        eventEmitter.emit({ type: "turn.end", sessionId, status: turnStatus });
        streaming = false;
        currentAbort = undefined;
      }
    },
    cancel() {
      currentAbort?.abort();
    },
    messages() {
      return [...currentMessages];
    },
    async branchFrom(messageId, branchOptions) {
      const index = currentMessages.findIndex((message) => message.id === messageId);
      if (index === -1) {
        throw new AgentError(`Unknown branch point: ${messageId}`, "UNKNOWN_BRANCH_POINT");
      }

      if (beforeBranch) {
        const patch = await beforeBranch({
          sessionId,
          messageId,
          messages: [...currentMessages],
        });
        if (patch?.cancel) {
          throw new AgentError(patch.reason ?? "Branch cancelled.", "BRANCH_CANCELLED");
        }
      }

      const baseMessages = currentMessages.slice(0, index + 1);

      const branchSessionId = branchOptions?.sessionId ?? generateId();
      const branchMeta = makeSessionMetadata({
        sessionId: branchSessionId,
        metadata: options.metadata,
        parentSessionId: sessionId,
        branchedFromMessageId: messageId,
      });

      await storage.branchSession({
        childSession: branchMeta,
        parentSessionId: sessionId,
        branchMessageId: messageId,
      });

      return createSessionInternal(
        {
          ...options,
          sessionId: branchSessionId,
          attach: false,
          seedMessages: undefined,
          llm: { llm, model },
          tools: [...customTools],
          beforeInput,
          beforeBranch,
          beforeToolCall,
          afterToolCall,
          beforeLLMCall,
          beforeCompaction,
          beforePrompt,
          transformContext,
        },
        {
          sessionId: branchSessionId,
          messages: baseMessages,
          parentSessionId: sessionId,
          branchedFromMessageId: messageId,
        },
      );
    },
    addTool(tool) {
      customTools = [...customTools.filter((candidate) => candidate.id !== tool.id), tool];
      registry.set(customTools);
      emitToolsChanged();
    },
    removeTool(id) {
      customTools = customTools.filter((tool) => tool.id !== id);
      registry.set(customTools);
      emitToolsChanged();
    },
    setTools(tools) {
      customTools = [...tools];
      registry.set(customTools);
      emitToolsChanged();
    },
    getTools() {
      return registry.list();
    },
    setBeforeInput(hook) {
      beforeInput = hook;
    },
    setBeforeBranch(hook) {
      beforeBranch = hook;
    },
    setBeforeToolCall(hook) {
      beforeToolCall = hook;
    },
    setAfterToolCall(hook) {
      afterToolCall = hook;
    },
    setTransformContext(transform) {
      transformContext = transform;
    },
    setBeforePrompt(hook) {
      beforePrompt = hook;
    },
    setBeforeLLMCall(hook) {
      beforeLLMCall = hook;
    },
    async compact() {
      if (streaming) {
        throw new AgentError("Cannot compact while a prompt is in progress.", "COMPACT_REJECTED");
      }
      const abort = new AbortController();
      const didCompact = await compactHistory("manual", abort.signal);
      if (didCompact) {
        await storage.writeCompactionHistorySnapshot(sessionId, [...currentMessages]);
      }
      return didCompact;
    },
    setBeforeCompaction(hook) {
      beforeCompaction = hook;
    },
    setLLM(next) {
      llm = next.llm;
      model = next.model;
    },
    get isStreaming() {
      return streaming;
    },
    get model() {
      return model;
    },
  };

  return session;
}

export async function createSession<TMeta extends MetadataBag = MetadataBag>(
  options: SessionOptions<TMeta>,
): Promise<Session> {
  return createSessionInternal(options as SessionOptions);
}

/**
 * Read-only convenience that projects stored history back into prompt-visible
 * messages and surfaces the session's metadata and lineage. Pass the result to
 * `createSession({ attach: true, seedMessages })` to continue the session with
 * your own code-defined configuration.
 */
export async function readSession<TMeta extends MetadataBag = MetadataBag>(
  storage: SessionStorageDriver,
  sessionId: string,
): Promise<LoadedSession<TMeta> | null>;
export async function readSession<TSchema extends z.ZodType<MetadataBag>>(
  storage: SessionStorageDriver,
  sessionId: string,
  options: { metadata: TSchema },
): Promise<LoadedSession<z.infer<TSchema>> | null>;
export async function readSession(
  storage: SessionStorageDriver,
  sessionId: string,
  options?: { metadata?: z.ZodType<MetadataBag> },
): Promise<LoadedSession | null> {
  const adapter = new SessionPersistenceAdapter(storage);
  const existing = await adapter.loadSession(sessionId);
  if (!existing) {
    return null;
  }
  const messages = await adapter.loadVisibleMessages(sessionId);
  const metadata = options?.metadata
    ? existing.metadata === undefined
      ? undefined
      : options.metadata.parse(existing.metadata)
    : existing.metadata;
  return {
    metadata,
    messages,
    parentSessionId: existing.parentSessionId,
    branchedFromMessageId: existing.branchedFromMessageId,
  };
}

function storageSessionToInfo<TMeta extends MetadataBag = MetadataBag>(
  session: StorageSession,
): SessionInfo<TMeta> {
  return {
    id: session.id,
    parentSessionId: session.parentSessionId,
    branchedFromMessageId: session.branchedFromMessageId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metadata: session.metadata as TMeta | undefined,
  };
}

export async function listSessions<TMeta extends MetadataBag = MetadataBag>(
  storage: SessionStorageDriver,
  options?: { limit?: number; offset?: number },
): Promise<SessionInfo<TMeta>[]> {
  const sessions = await storage.listSessions(options);
  return sessions.map((session) => storageSessionToInfo<TMeta>(session));
}

export async function listBranches<TMeta extends MetadataBag = MetadataBag>(
  storage: SessionStorageDriver,
  sessionId: string,
): Promise<SessionInfo<TMeta>[]> {
  const sessions = await storage.listSessionsByParent(sessionId);
  return sessions.map((session) => storageSessionToInfo<TMeta>(session));
}

export async function getSessionInfo<TMeta extends MetadataBag = MetadataBag>(
  storage: SessionStorageDriver,
  sessionId: string,
): Promise<SessionInfo<TMeta> | null> {
  const session = await storage.getSession(sessionId);
  return session ? storageSessionToInfo<TMeta>(session) : null;
}
