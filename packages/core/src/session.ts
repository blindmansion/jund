import { CODER_AGENT, EXPLORER_AGENT, type AgentConfig } from "./agent.ts";
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
import { buildSystemPrompt } from "./prompt.ts";
import { ToolRegistry, buildToolMap, filterToolsForAgent, toLLMTool } from "./tool/registry.ts";
import { FileMutationQueue } from "./tool/queue.ts";
import { taskTool } from "./tool/task.ts";
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
  Session as StorageSession,
  SessionMetadata,
  SessionStorageDriver,
} from "./storage/types.ts";
import { generateId } from "./util/id.ts";

export interface SessionOptions {
  sessionId?: string;
  llm: LLMProviderWithModel;
  agents?: AgentConfig[];
  defaultAgent?: string;
  tools?: ToolDef[];
  systemPrompt?: string;
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
}

export interface BranchOptions {
  sessionId?: string;
}

export interface ResumeOptions {
  llm: LLMProviderWithModel;
  storage: SessionStorageDriver;
  defaultAgent?: string;
  agents?: AgentConfig[];
  tools?: ToolDef[];
  systemPrompt?: string;
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
}

export interface SessionInfo {
  id: string;
  parentSessionId: string | undefined;
  branchedFromMessageId: string | undefined;
  model: ModelRef;
  agent: string;
  createdAt: number;
  updatedAt: number;
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
  setLLM(llm: LLMProviderWithModel): Promise<void>;
  readonly isStreaming: boolean;
  readonly model: ModelInfo;
}

function shouldInstallTaskTool(agent: AgentConfig): boolean {
  if (agent.deniedTools?.includes("task")) {
    return false;
  }
  if (agent.mode !== "subagent") {
    return true;
  }
  return agent.tools?.includes("task") ?? false;
}

function getBuiltInTools(agent: AgentConfig): ToolDef[] {
  return shouldInstallTaskTool(agent) ? [taskTool] : [];
}

function buildAgentMap(customAgents: AgentConfig[] = []): Map<string, AgentConfig> {
  return new Map(
    [CODER_AGENT, EXPLORER_AGENT, ...customAgents].map((agent) => [agent.name, agent] as const),
  );
}

function resolveConfiguredAgent(
  defaultAgent: string | undefined,
  customAgents: AgentConfig[] | undefined,
): AgentConfig {
  return buildAgentMap(customAgents).get(defaultAgent ?? CODER_AGENT.name) ?? CODER_AGENT;
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
  model: ModelInfo;
  agent: string;
  parentSessionId?: string;
  branchedFromMessageId?: string;
}): SessionMetadata {
  const now = Date.now();
  return {
    id: options.sessionId,
    model: toMessageModel(options.model),
    agent: options.agent,
    createdAt: now,
    updatedAt: now,
    parentSessionId: options.parentSessionId,
    branchedFromMessageId: options.branchedFromMessageId,
  };
}

function resolveStorage(storage: SessionStorageDriver | undefined): SessionPersistenceAdapter {
  return new SessionPersistenceAdapter(storage ?? new MemoryStorage());
}

async function initializeSessionState(
  options: SessionOptions,
  storage: SessionPersistenceAdapter,
): Promise<SessionState> {
  const sessionId = options.sessionId ?? generateId();

  if (options.sessionId) {
    const existing = await storage.loadSession(sessionId);
    if (existing) {
      throw new AgentError(`Session already exists: ${sessionId}`, "SESSION_EXISTS");
    }
  }

  const agentName = resolveConfiguredAgent(options.defaultAgent, options.agents).name;
  const meta = makeSessionMetadata({
    sessionId,
    model: options.llm.model,
    agent: agentName,
  });
  await storage.createSession(meta);
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
  let pendingModelSwitch: Promise<void> | undefined;

  const eventEmitter = createEventEmitter(options.onEvent);
  const queue = new FileMutationQueue();
  const agents = buildAgentMap(options.agents);
  const resolveAgent = () => agents.get(options.defaultAgent ?? CODER_AGENT.name) ?? CODER_AGENT;
  let customTools = [...(options.tools ?? [])];
  const currentMessages: Message[] = [...state.messages];
  let compactedDuringTurn = false;
  const spawnSubagent = async (input: {
    prompt: string;
    agent?: string;
    signal: AbortSignal;
    onUpdate?: (chunk: string) => void;
  }): Promise<{ sessionId: string; agent: string; message: AssistantMessage }> => {
    const targetAgentName = input.agent ?? EXPLORER_AGENT.name;
    const targetAgent = agents.get(targetAgentName);
    if (!targetAgent) {
      throw new Error(`Unknown subagent: ${targetAgentName}`);
    }

    const childSessionId = generateId();
    const child = await createSessionInternal({
      ...options,
      sessionId: childSessionId,
      llm: { llm, model },
      defaultAgent: targetAgent.name,
      tools: [...customTools],
      transformContext,
      beforeInput,
      beforeBranch,
      beforeToolCall,
      afterToolCall,
      beforeLLMCall,
      beforeCompaction,
      beforePrompt,
      onEvent(event) {
        switch (event.type) {
          case "text.delta":
            input.onUpdate?.(event.text);
            break;
          case "tool.output":
            input.onUpdate?.(event.chunk);
            break;
          default:
            break;
        }
      },
    });

    const abortChild = () => {
      child.cancel();
    };
    if (input.signal.aborted) {
      abortChild();
    } else {
      input.signal.addEventListener("abort", abortChild, { once: true });
    }

    try {
      const message = await child.prompt(input.prompt);
      return { sessionId: child.id, agent: targetAgent.name, message };
    } finally {
      input.signal.removeEventListener("abort", abortChild);
    }
  };
  const currentBuiltInTools = () => getBuiltInTools(resolveAgent());
  const registry = new ToolRegistry([...currentBuiltInTools(), ...customTools]);

  const emitToolsChanged = () =>
    eventEmitter.emit({
      type: "tools.changed",
      tools: registry.list().map((tool) => tool.id),
    });

  const rebuildRegistry = () => {
    registry.set([...currentBuiltInTools(), ...customTools]);
  };

  const awaitPendingModelSwitch = async () => {
    if (pendingModelSwitch) {
      await pendingModelSwitch;
    }
  };

  const replaceMessageHistory = (messages: Message[]) => {
    currentMessages.splice(0, currentMessages.length, ...messages);
  };

  const compactHistory = async (
    reason: CompactionReason,
    activeAgent: AgentConfig,
    signal: AbortSignal,
  ) => {
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
      agent: activeAgent.name,
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
      await awaitPendingModelSwitch();

      if (beforeInput) {
        const patch = await beforeInput({ input, sessionId });
        if (patch?.reject) {
          throw new AgentError(patch.reason ?? "Input rejected.", "INPUT_REJECTED");
        }
        if (patch?.input !== undefined) {
          input = patch.input;
        }
      }

      const agent = resolveAgent();
      const userMessage: Message = {
        id: generateId(),
        role: "user",
        parts: typeof input === "string" ? [{ type: "text", text: input }] : input,
        agent: agent.name,
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
          const activeAgent = resolveAgent();
          const activeTools = filterToolsForAgent(registry.list(), activeAgent);
          const baseSystemPrompt = buildSystemPrompt({
            agentPrompt: activeAgent.systemPrompt,
            tools: activeTools,
            appendPrompt: options.systemPrompt,
          });

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
            const didCompact = await compactHistory("proactive", activeAgent, currentAbort.signal);
            if (didCompact) {
              continue;
            }
          }

          const transformedMessages = await transformForTurn(
            currentMessages,
            transformContext,
            currentAbort.signal,
          );

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
            spawnSubagent,
            agent: activeAgent.name,
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
              await compactHistory("reactive", activeAgent, currentAbort.signal);
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
          if (activeAgent.maxSteps !== undefined && steps >= activeAgent.maxSteps) {
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
      await awaitPendingModelSwitch();
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
        model,
        agent: resolveAgent().name,
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
      rebuildRegistry();
      emitToolsChanged();
    },
    removeTool(id) {
      customTools = customTools.filter((tool) => tool.id !== id);
      rebuildRegistry();
      emitToolsChanged();
    },
    setTools(tools) {
      customTools = [...tools];
      rebuildRegistry();
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
      const agent = resolveAgent();
      const didCompact = await compactHistory("manual", agent, abort.signal);
      if (didCompact) {
        await storage.writeCompactionHistorySnapshot(sessionId, [...currentMessages]);
      }
      return didCompact;
    },
    setBeforeCompaction(hook) {
      beforeCompaction = hook;
    },
    async setLLM(next) {
      await awaitPendingModelSwitch();
      const switchPromise = (async () => {
        await storage.updateSessionMetadata(sessionId, {
          resumeTurnConfig: {
            agent: resolveAgent().name,
            model: toMessageModel(next.model),
          },
        });
        llm = next.llm;
        model = next.model;
      })();
      pendingModelSwitch = switchPromise;
      try {
        await switchPromise;
      } finally {
        if (pendingModelSwitch === switchPromise) {
          pendingModelSwitch = undefined;
        }
      }
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

export async function createSession(options: SessionOptions): Promise<Session> {
  return createSessionInternal(options);
}

export async function resumeSession(sessionId: string, options: ResumeOptions): Promise<Session> {
  const storage = new SessionPersistenceAdapter(options.storage);
  const existing = await storage.loadSession(sessionId);
  if (!existing) {
    throw new AgentError(`Session not found: ${sessionId}`, "SESSION_NOT_FOUND");
  }

  const defaultAgent = options.defaultAgent ?? existing.resumeTurnConfig.agent;
  const agentName = resolveConfiguredAgent(defaultAgent, options.agents).name;

  await storage.updateSessionMetadata(sessionId, {
    resumeTurnConfig: { agent: agentName, model: toMessageModel(options.llm.model) },
  });

  const messages = await storage.loadVisibleMessages(sessionId);

  return createSessionInternal(
    {
      sessionId,
      llm: options.llm,
      defaultAgent,
      agents: options.agents,
      tools: options.tools,
      systemPrompt: options.systemPrompt,
      maxOutputChars: options.maxOutputChars,
      toolExecution: options.toolExecution,
      transformContext: options.transformContext,
      beforeInput: options.beforeInput,
      beforeBranch: options.beforeBranch,
      beforeToolCall: options.beforeToolCall,
      afterToolCall: options.afterToolCall,
      beforeLLMCall: options.beforeLLMCall,
      beforePrompt: options.beforePrompt,
      onEvent: options.onEvent,
      retry: options.retry,
      compaction: options.compaction,
      beforeCompaction: options.beforeCompaction,
      storage: options.storage,
    },
    {
      sessionId,
      messages,
      parentSessionId: existing.parentSessionId,
      branchedFromMessageId: existing.branchedFromMessageId,
    },
  );
}

function storageSessionToInfo(session: StorageSession): SessionInfo {
  return {
    id: session.id,
    parentSessionId: session.parentSessionId,
    branchedFromMessageId: session.branchedFromMessageId,
    model: { ...session.resumeTurnConfig.model },
    agent: session.resumeTurnConfig.agent,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export async function listSessions(
  storage: SessionStorageDriver,
  options?: { limit?: number; offset?: number },
): Promise<SessionInfo[]> {
  const sessions = await storage.listSessions(options);
  return sessions.map(storageSessionToInfo);
}

export async function listBranches(
  storage: SessionStorageDriver,
  sessionId: string,
): Promise<SessionInfo[]> {
  const sessions = await storage.listSessionsByParent(sessionId);
  return sessions.map(storageSessionToInfo);
}

export async function getSessionInfo(
  storage: SessionStorageDriver,
  sessionId: string,
): Promise<SessionInfo | null> {
  const session = await storage.getSession(sessionId);
  return session ? storageSessionToInfo(session) : null;
}
