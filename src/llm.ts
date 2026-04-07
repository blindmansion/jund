import type { Message, ToolCallPart } from "./types.ts";

// ── LLM provider interface ──────────────────────────────────────────────────

export interface LLMProvider {
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools: LLMToolDef[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

// The harness's own message format for LLM calls, converted from internal Message[]
export interface LLMMessage {
  role: "user" | "assistant";
  content: LLMContent[];
}

export type LLMContent =
  | { type: "text"; text: string }
  | { type: "image"; data: Uint8Array; mime: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; content: string; isError?: boolean };

export interface LLMToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export type LLMStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "finish";
      reason: string;
      tokens: { input: number; output: number };
    }
  | { type: "error"; error: Error };

// ── Model info ──────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
  capabilities: {
    reasoning: boolean;
    toolCalls: boolean;
    images: boolean;
  };
  cost?: { input: number; output: number };
}

/**
 * Same shape as ModelInfo but with `name` optional (defaults to `id`).
 * Used by adapter factories so callers don't have to repeat the model name.
 */
export interface ModelInfoInit {
  id: string;
  name?: string;
  contextLimit: number;
  outputLimit: number;
  capabilities: {
    reasoning: boolean;
    toolCalls: boolean;
    images: boolean;
  };
  cost?: { input: number; output: number };
}

export function resolveModelInfo(init: ModelInfoInit): ModelInfo {
  return {
    id: init.id,
    name: init.name ?? init.id,
    contextLimit: init.contextLimit,
    outputLimit: init.outputLimit,
    capabilities: init.capabilities,
    cost: init.cost,
  };
}

export interface LLMProviderWithModel {
  llm: LLMProvider;
  model: ModelInfo;
}

// ── Message conversion ──────────────────────────────────────────────────────
// Converts internal Message[] → LLMMessage[] for the provider.
// Provider-specific conversion happens inside the LLMProvider adapter.

function toolCallPartToResult(part: ToolCallPart): LLMContent {
  switch (part.state.status) {
    case "completed":
      return {
        type: "tool-result",
        id: part.id,
        content: part.state.output,
      };
    case "error":
      return {
        type: "tool-result",
        id: part.id,
        content: part.state.error,
        isError: true,
      };
    case "pending":
    case "running":
      return {
        type: "tool-result",
        id: part.id,
        content: "[Tool execution incomplete]",
        isError: true,
      };
  }
}

export function toLLMMessages(messages: Message[]): LLMMessage[] {
  const result: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content: LLMContent[] = [];
      for (const part of msg.parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        }
      }
      if (content.length > 0) {
        result.push({ role: "user", content });
      }
      continue;
    }

    // Assistant message → assistant content + tool results
    const assistantContent: LLMContent[] = [];
    const toolResults: LLMContent[] = [];

    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          assistantContent.push({ type: "text", text: part.text });
          break;
        case "reasoning":
          break;
        case "tool":
          assistantContent.push({
            type: "tool-call",
            id: part.id,
            name: part.tool,
            args: part.input,
          });
          toolResults.push(toolCallPartToResult(part));
          break;
      }
    }

    if (assistantContent.length > 0) {
      result.push({ role: "assistant", content: assistantContent });
    }
    if (toolResults.length > 0) {
      result.push({ role: "user", content: toolResults });
    }
  }

  return result;
}
