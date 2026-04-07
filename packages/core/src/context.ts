import type { AssistantMessage, Message, ModelRef } from "./types.ts";
import { AgentError } from "./types.ts";
import type { LLMMessage } from "./llm.ts";
import type { CompactionContext, ContextTransform } from "./tool/types.ts";
import { toLLMMessages } from "./llm.ts";
import { callLLM } from "./processor.ts";
import { generateId } from "./util/id.ts";

// ── Token estimation ────────────────────────────────────────────────────────
// Rough heuristic: ~4 characters per token for English text.
// Good enough for proactive compaction checks — we're not billing, just avoiding
// context overflow. Off by 20-30% is fine; the reactive fallback catches the rest.

const CHARS_PER_TOKEN = 4;
export const DEFAULT_COMPACTION_THRESHOLD = 0.8;
export const DEFAULT_COMPACTION_SYSTEM_PROMPT = [
  "You are summarizing an agent conversation to reduce context usage.",
  "Write a concise summary of the earlier conversation so the agent can continue the task.",
  "Preserve the user's goal, key decisions, important file paths, constraints, tool results, and unfinished work.",
  "Do not invent details and do not include meta commentary.",
  "Return only the summary text.",
].join("\n");

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
        case "reasoning":
          chars += part.text.length;
          break;
        case "file":
          chars += part.path.length + part.mime.length;
          break;
        case "tool":
          chars += part.tool.length;
          chars +=
            typeof part.input === "string" ? part.input.length : JSON.stringify(part.input).length;
          if (part.state.status === "completed") {
            chars += part.state.output.length;
          } else if (part.state.status === "error") {
            chars += part.state.error.length;
          }
          break;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function shouldCompact(
  messages: Message[],
  contextLimit: number,
  threshold = DEFAULT_COMPACTION_THRESHOLD,
): boolean {
  return estimateTokens(messages) > contextLimit * threshold;
}

function toMessageModel(model: CompactionContext["model"]): ModelRef {
  const parts = model.id.split(":");
  if (parts.length > 1) {
    return { provider: parts[0]!, model: parts.slice(1).join(":") };
  }
  return { provider: "unknown", model: model.id };
}

function lastUserMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") {
      return index;
    }
  }
  return -1;
}

function assistantText(message: AssistantMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

export async function defaultCompactionStrategy(
  messages: Message[],
  ctx: CompactionContext,
): Promise<Message[]> {
  const preservedStart = lastUserMessageIndex(messages);
  if (preservedStart <= 0) {
    return messages;
  }

  const summarySource = messages.slice(0, preservedStart);
  const preservedMessages = messages.slice(preservedStart);
  if (summarySource.length === 0) {
    return messages;
  }

  const summaryTurn = await callLLM({
    message: {
      id: generateId(),
      role: "assistant",
      parts: [],
      agent: ctx.agent,
      model: toMessageModel(ctx.model),
    },
    llm: ctx.llm,
    system: ctx.summarySystemPrompt,
    messages: toLLMMessages(summarySource),
    sessionId: ctx.sessionId,
    agent: ctx.agent,
    abort: ctx.signal,
    retry: ctx.retry,
  });

  if (summaryTurn.error) {
    throw summaryTurn.error;
  }

  const summary = assistantText(summaryTurn);
  if (!summary) {
    throw new AgentError("Compaction summary was empty.", "COMPACTION_FAILED");
  }

  return [
    {
      id: generateId(),
      role: "assistant",
      parts: [{ type: "text", text: `[Compacted summary]\n${summary}` }],
      agent: ctx.agent,
      model: toMessageModel(ctx.model),
      finishReason: "end-turn",
    },
    ...preservedMessages,
  ];
}

// ── Context pipeline ────────────────────────────────────────────────────────
// Two-stage pipeline:
//   1. transformContext(messages) — prune, inject, compact (host-provided or pass-through)
//   2. toLLMMessages(messages)   — convert to LLMMessage[] for the provider

const IDENTITY_TRANSFORM: ContextTransform = async (msgs) => msgs;

export interface ContextPipelineOptions {
  transform?: ContextTransform;
  signal?: AbortSignal;
}

export async function runContextPipeline(
  messages: Message[],
  options: ContextPipelineOptions = {},
): Promise<LLMMessage[]> {
  const transform = options.transform ?? IDENTITY_TRANSFORM;
  const transformed = await transform(messages, options.signal);
  return toLLMMessages(transformed);
}
