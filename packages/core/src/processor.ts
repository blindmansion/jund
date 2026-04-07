import {
  AgentError,
  type AssistantMessage,
  type Environment,
  type ModelRef,
  type ToolCallPart,
} from "./types.ts";
import type { AgentEvent } from "./events.ts";
import type { LLMMessage, LLMProvider, LLMToolDef } from "./llm.ts";
import { executeToolWithHooks } from "./tool/hooks.ts";
import { executeToolWithQueue, FileMutationQueue } from "./tool/queue.ts";
import type {
  AfterToolCallHook,
  BeforeLLMCallHook,
  BeforeToolCallHook,
  ToolContext,
  ToolDef,
  ToolResult,
} from "./tool/types.ts";
import { truncateOutput } from "./util/truncate.ts";
import { generateId } from "./util/id.ts";

const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

// ── Error classification ────────────────────────────────────────────────────

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isContextOverflowMessage(message: string): boolean {
  return /(context length|context window|context limit|maximum context|prompt is too long|input is too long)/i.test(
    message,
  );
}

function isRetryableMessage(message: string): boolean {
  return /(rate limit|too many requests|overloaded|temporar(?:ily)? unavailable|timed? out|connection reset|connection error|network error|econnreset|econnrefused|etimedout|429|500|502|503|504)/i.test(
    message,
  );
}

function toAgentError(error: unknown): AgentError {
  if (isAbortError(error)) {
    return new AgentError("The request was aborted.", "ABORTED");
  }
  if (error instanceof AgentError) {
    return error;
  }
  const status = getErrorStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  if (isContextOverflowMessage(message)) {
    return new AgentError(message, "CONTEXT_OVERFLOW");
  }
  if (isRetryableStatus(status) || isRetryableMessage(message)) {
    return new AgentError(message, "LLM_STREAM", true);
  }
  if (error instanceof Error) {
    return new AgentError(error.message, "LLM_STREAM");
  }
  return new AgentError(String(error), "LLM_STREAM");
}

function getRetryDelayMs(attempt: number, maxDelayMs: number): number {
  return Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1), maxDelayMs);
}

// ── callLLM: stream + retry, no tool execution ─────────────────────────────

export interface CallLLMOptions {
  message: AssistantMessage;
  llm: LLMProvider;
  system: string;
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  abort: AbortSignal;
  sessionId: string;
  agent: string;
  temperature?: number;
  maxOutputTokens?: number;
  retry?: { maxAttempts?: number; maxDelayMs?: number };
  beforeLLMCall?: BeforeLLMCallHook;
  emit?: (event: AgentEvent) => void;
  onToolCall?: (toolCall: { id: string; name: string; args: unknown }, part: ToolCallPart) => void;
}

export async function callLLM(options: CallLLMOptions): Promise<AssistantMessage> {
  const emit = options.emit ?? (() => {});
  const message = options.message;

  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS);
  const maxDelayMs = Math.max(0, options.retry?.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);

  let temperature = options.temperature;
  let maxOutputTokens = options.maxOutputTokens;
  let providerOptions: Record<string, unknown> | undefined;

  if (options.beforeLLMCall) {
    const patch = await options.beforeLLMCall({
      sessionId: options.sessionId,
      agent: options.agent,
      system: options.system,
      messages: options.messages,
      tools: options.tools ?? [],
      temperature,
      maxOutputTokens,
      signal: options.abort,
    });
    if (patch) {
      if (patch.temperature !== undefined) temperature = patch.temperature;
      if (patch.maxOutputTokens !== undefined) maxOutputTokens = patch.maxOutputTokens;
      if (patch.providerOptions !== undefined) providerOptions = patch.providerOptions;
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    message.parts = [];
    message.tokens = undefined;
    message.finishReason = undefined;
    message.error = undefined;

    let textPart: Extract<AssistantMessage["parts"][number], { type: "text" }> | undefined;
    let reasoningPart:
      | Extract<AssistantMessage["parts"][number], { type: "reasoning" }>
      | undefined;
    let streamError: AgentError | undefined;

    try {
      streamLoop: for await (const event of options.llm.stream({
        system: options.system,
        messages: options.messages,
        tools: options.tools ?? [],
        temperature,
        maxOutputTokens,
        providerOptions,
        signal: options.abort,
      })) {
        switch (event.type) {
          case "text-delta":
            if (!textPart) {
              textPart = { type: "text", text: "" };
              message.parts.push(textPart);
            }
            textPart.text += event.text;
            emit({ type: "text.delta", messageId: message.id, text: event.text });
            break;
          case "reasoning-delta":
            if (!reasoningPart) {
              reasoningPart = { type: "reasoning", text: "" };
              message.parts.push(reasoningPart);
            }
            reasoningPart.text += event.text;
            emit({ type: "reasoning.delta", messageId: message.id, text: event.text });
            break;
          case "tool-call": {
            const part: ToolCallPart = {
              type: "tool",
              id: event.id,
              tool: event.name,
              input: event.args,
              state: { status: "pending" },
            };
            message.parts.push(part);
            options.onToolCall?.(event, part);
            break;
          }
          case "finish":
            message.finishReason = event.reason;
            message.tokens = event.tokens;
            break;
          case "error":
            streamError = toAgentError(event.error);
            break streamLoop;
        }
      }
    } catch (error) {
      streamError = toAgentError(error);
    }

    if (
      streamError &&
      streamError.retryable &&
      message.parts.length === 0 &&
      attempt < maxAttempts
    ) {
      const delayMs = getRetryDelayMs(attempt, maxDelayMs);
      emit({
        type: "retry",
        attempt,
        maxAttempts,
        delayMs,
        error: streamError.message,
      });
      await Bun.sleep(delayMs);
      continue;
    }

    if (streamError) {
      message.error = streamError;
      message.finishReason = "error";
      emit({ type: "error", error: streamError });
    }

    if (!message.finishReason) {
      message.finishReason = "end-turn";
    }

    return message;
  }

  return message;
}

// ── processTurn: full agent turn with tool execution ────────────────────────

export interface ProcessTurnOptions {
  llm: LLMProvider;
  system: string;
  messages: LLMMessage[];
  tools: LLMToolDef[];
  toolMap: Map<string, ToolDef>;
  sessionId: string;
  workdir: string;
  env: Environment;
  spawnSubagent?: ToolContext["spawnSubagent"];
  agent: string;
  model: ModelRef;
  abort: AbortSignal;
  emit(event: AgentEvent): void;
  queue: FileMutationQueue;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
  beforeLLMCall?: BeforeLLMCallHook;
  toolExecution?: "parallel" | "sequential";
  temperature?: number;
  maxOutputTokens?: number;
  maxOutputChars?: number;
  retry?: { maxAttempts?: number; maxDelayMs?: number };
}

function toolErrorResult(message: string): { result: ToolResult; isError: true } {
  return {
    result: { output: message },
    isError: true,
  };
}

async function executeModelTool(
  toolCall: { id: string; name: string; args: unknown },
  messageId: string,
  options: ProcessTurnOptions,
): Promise<{ result: ToolResult; isError: boolean }> {
  const tool = options.toolMap.get(toolCall.name);
  if (!tool) {
    return toolErrorResult(`Unknown tool: ${toolCall.name}`);
  }

  let args = tool.prepareArgs ? tool.prepareArgs(toolCall.args) : toolCall.args;
  const parsed = tool.parameters.safeParse(args);
  if (!parsed.success) {
    return toolErrorResult(
      `Invalid arguments for ${toolCall.name}: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  args = parsed.data;

  const queuedTool: ToolDef = {
    ...tool,
    execute: (params, ctx) =>
      executeToolWithQueue({
        tool,
        args: params,
        ctx,
        queue: options.queue,
      }),
  };

  const { result, isError } = await executeToolWithHooks({
    tool: queuedTool,
    args,
    ctx: {
      sessionId: options.sessionId,
      workdir: options.workdir,
      abort: options.abort,
      env: options.env,
      spawnSubagent: options.spawnSubagent,
      onUpdate(partial) {
        if (partial.output) {
          options.emit({
            type: "tool.output",
            messageId,
            tool: toolCall.name,
            chunk: partial.output,
          });
        }
      },
    },
    toolCallId: toolCall.id,
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
  });

  const { text, truncated } = truncateOutput(result.output, options.maxOutputChars);
  return {
    result: {
      ...result,
      output: text,
      metadata: truncated ? { ...result.metadata, truncated: true } : result.metadata,
    },
    isError,
  };
}

export async function processTurn(options: ProcessTurnOptions): Promise<AssistantMessage> {
  const toolPromises: Promise<void>[] = [];
  let toolChain = Promise.resolve();

  const message: AssistantMessage = {
    id: generateId(),
    role: "assistant",
    parts: [],
    agent: options.agent,
    model: options.model,
  };

  await callLLM({
    message,
    llm: options.llm,
    system: options.system,
    messages: options.messages,
    tools: options.tools,
    abort: options.abort,
    sessionId: options.sessionId,
    agent: options.agent,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    retry: options.retry,
    beforeLLMCall: options.beforeLLMCall,
    emit: options.emit,
    onToolCall(toolCall, part) {
      const execute = async () => {
        options.emit({
          type: "tool.start",
          messageId: message.id,
          tool: toolCall.name,
          input: toolCall.args,
        });

        const startedAt = Date.now();
        part.state = { status: "running", startedAt };

        const { result, isError } = await executeModelTool(toolCall, message.id, options);
        const duration = Date.now() - startedAt;
        part.state = isError
          ? { status: "error", error: result.output, duration }
          : { status: "completed", output: result.output, duration };

        options.emit({
          type: "tool.end",
          messageId: message.id,
          tool: toolCall.name,
          result,
        });
      };

      const promise =
        options.toolExecution === "sequential"
          ? (toolChain = toolChain.then(execute, execute))
          : execute();
      toolPromises.push(promise);
    },
  });

  await Promise.all(toolPromises);

  if (message.tokens) {
    options.emit({
      type: "step.finish",
      messageId: message.id,
      tokens: message.tokens,
    });
  }

  return message;
}
