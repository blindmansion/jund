// ── Core types ──────────────────────────────────────────────────────────────

export type {
  FileSystem,
  ShellExecOptions,
  ShellOps,
  Environment,
  ModelRef,
  Message,
  UserMessage,
  AssistantMessage,
  UserPart,
  AssistantPart,
  TextPart,
  FilePart,
  ReasoningPart,
  ToolCallPart,
  ToolCallState,
} from "./types.ts";

export { AgentError } from "./types.ts";

// ── LLM types ───────────────────────────────────────────────────────────────

export type {
  LLMProvider,
  LLMProviderWithModel,
  LLMRequest,
  LLMMessage,
  LLMContent,
  LLMToolDef,
  LLMStreamEvent,
  ModelInfo,
  ModelInfoInit,
} from "./llm.ts";

export { toLLMMessages, resolveModelInfo } from "./llm.ts";

// ── Tool types ──────────────────────────────────────────────────────────────

export type {
  ToolDef,
  ToolContext,
  ToolResult,
  BeforeInputHook,
  BeforeBranchHook,
  BeforeCompactionHook,
  BeforeToolCallHook,
  AfterToolCallHook,
  BeforeLLMCallHook,
  ContextTransform,
  CompactionReason,
  CompactionContext,
  CompactionStrategy,
  CompactionOptions,
  BeforePromptHook,
} from "./tool/types.ts";

export { ToolRegistry, buildToolMap, filterToolsForAgent, toLLMTool } from "./tool/registry.ts";

export { executeToolWithHooks } from "./tool/hooks.ts";

export { FileMutationQueue, executeToolWithQueue, getBuiltInMutationPath } from "./tool/queue.ts";

// ── Event types ─────────────────────────────────────────────────────────────

export type { AgentEvent, EventHandler } from "./events.ts";

export { createEventEmitter } from "./events.ts";

// ── Context pipeline ────────────────────────────────────────────────────────

export {
  estimateTokens,
  shouldCompact,
  runContextPipeline,
  defaultCompactionStrategy,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_COMPACTION_SYSTEM_PROMPT,
} from "./context.ts";

export type { ContextPipelineOptions } from "./context.ts";

// ── Agent config ────────────────────────────────────────────────────────────

export type { AgentConfig } from "./agent.ts";

export { CODER_AGENT, EXPLORER_AGENT } from "./agent.ts";

// ── Storage ─────────────────────────────────────────────────────────────────

export type { SessionMetadata, SessionStorageDriver } from "./storage/types.ts";

export {
  SessionPersistenceAdapter,
  MemoryStorage,
  BetterSqlite3Storage,
  BunSqliteStorage,
  DurableObjectSqliteStorage,
  PgStorage,
} from "./storage/index.ts";

// ── Session runtime ──────────────────────────────────────────────────────────

export type {
  BranchOptions,
  ResumeOptions,
  Session,
  SessionInfo,
  SessionOptions,
} from "./session.ts";

export {
  createSession,
  resumeSession,
  listSessions,
  listBranches,
  getSessionInfo,
} from "./session.ts";

export type { CallLLMOptions, ProcessTurnOptions } from "./processor.ts";

export { callLLM, processTurn } from "./processor.ts";

export type { BuildSystemPromptOptions } from "./prompt.ts";

export { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompt.ts";

// ── Built-in tools ──────────────────────────────────────────────────────────

export { readTool } from "./tool/read.ts";

export { writeTool } from "./tool/write.ts";

export { editTool, normalizeEditArgs } from "./tool/edit.ts";

export { bashTool } from "./tool/bash.ts";

export type { TaskParams } from "./tool/task.ts";

export { taskTool } from "./tool/task.ts";

// ── Utilities ───────────────────────────────────────────────────────────────

export { generateId } from "./util/id.ts";
export { getAssistantText } from "./util/message.ts";
export { resolvePath } from "./util/path.ts";
export { truncateOutput } from "./util/truncate.ts";
export { unifiedDiff } from "./util/diff.ts";
