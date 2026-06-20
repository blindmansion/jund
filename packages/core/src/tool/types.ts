import type { z } from "zod";
import type { LLMMessage, LLMProvider, LLMToolDef, ModelInfo } from "../llm.ts";
import type { AssistantMessage, Message, UserPart } from "../types.ts";

// ── Tool definition ─────────────────────────────────────────────────────────

export interface ToolDef<Params = any> {
  id: string;
  description: string;
  parameters: z.ZodType<Params>;

  promptSnippet?: string;
  promptGuidelines?: string[];

  prepareArgs?: (args: unknown) => unknown;

  /**
   * If set and it returns a key, the runtime serializes execution of calls that
   * resolve to the same key. Used to prevent concurrent mutations of the same
   * resource (e.g. two writes to one file) during parallel tool execution.
   */
  mutationKey?: (params: Params) => string | undefined;

  execute(params: Params, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  sessionId: string;
  abort: AbortSignal;
  onUpdate(partial: ToolResult): void;
  spawnSubagent?: (input: {
    prompt: string;
    agent?: string;
    signal: AbortSignal;
    onUpdate?: (chunk: string) => void;
  }) => Promise<{ sessionId: string; agent: string; message: AssistantMessage }>;
}

export interface ToolResult {
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

// ── Hook types ──────────────────────────────────────────────────────────────

export type BeforeToolCallHook = (ctx: {
  toolName: string;
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
}) => Promise<{ block?: boolean; reason?: string } | undefined>;

export type AfterToolCallHook = (ctx: {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: ToolResult;
  isError: boolean;
  signal?: AbortSignal;
}) => Promise<{ output?: string; isError?: boolean } | undefined>;

export type ContextTransform = (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;

export type CompactionReason = "proactive" | "reactive" | "manual";

export interface CompactionContext {
  sessionId: string;
  llm: LLMProvider;
  model: ModelInfo;
  agent: string;
  signal: AbortSignal;
  reason: CompactionReason;
  retry?: { maxAttempts?: number; maxDelayMs?: number };
  summarySystemPrompt: string;
}

export type CompactionStrategy = (
  messages: Message[],
  ctx: CompactionContext,
) => Promise<Message[]>;

export interface CompactionOptions {
  threshold?: number;
  strategy?: CompactionStrategy;
  summarySystemPrompt?: string;
}

export type BeforeLLMCallHook = (ctx: {
  sessionId: string;
  agent: string;
  system: string;
  messages: LLMMessage[];
  tools: LLMToolDef[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}) => Promise<
  | {
      temperature?: number;
      maxOutputTokens?: number;
      providerOptions?: Record<string, unknown>;
    }
  | undefined
>;

export type BeforeBranchHook = (ctx: {
  sessionId: string;
  messageId: string;
  messages: Message[];
}) => Promise<{ cancel: true; reason?: string } | undefined>;

export type BeforeCompactionHook = (ctx: {
  sessionId: string;
  reason: CompactionReason;
  messages: Message[];
  estimatedTokens: number;
}) => Promise<
  { cancel: true; messages?: never } | { messages: Message[]; cancel?: never } | undefined
>;

export type BeforeInputHook = (ctx: {
  input: string | UserPart[];
  sessionId: string;
}) => Promise<
  | { input?: string | UserPart[]; reject?: never }
  | { reject: true; reason?: string; input?: never }
  | undefined
>;

export type BeforePromptHook = (ctx: {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDef[];
}) => Promise<
  | {
      systemPrompt?: string;
      injectedMessages?: Message[];
    }
  | undefined
>;
