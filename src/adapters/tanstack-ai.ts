import type { AnyTextAdapter, JSONSchema, ModelMessage, ToolCall } from "@tanstack/ai";
import type {
  LLMMessage,
  LLMProviderWithModel,
  LLMRequest,
  LLMStreamEvent,
  ModelInfoInit,
} from "../llm.ts";
import { resolveModelInfo } from "../llm.ts";

export type TanStackStreamEvent =
  | { type: "TEXT_MESSAGE_CONTENT"; delta: string }
  | { type: "STEP_FINISHED"; delta?: string }
  | { type: "TOOL_CALL_END"; toolCallId: string; toolName: string; input?: unknown }
  | {
      type: "RUN_FINISHED";
      finishReason: string | null;
      usage?: { promptTokens?: number; completionTokens?: number };
    }
  | { type: "RUN_ERROR"; error: { message: string } };

export interface TanStackTextProviderOptions extends ModelInfoInit {
  /** TanStack text adapter from a provider package (e.g. `anthropicText(...)`). */
  adapter: AnyTextAdapter;
}

export function llmMessagesToTanStackModelMessages(messages: LLMMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter(
          (part): part is Extract<LLMMessage["content"][number], { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("");

      const toolCalls: ToolCall[] = message.content
        .filter(
          (part): part is Extract<LLMMessage["content"][number], { type: "tool-call" }> =>
            part.type === "tool-call",
        )
        .map((part) => ({
          id: part.id,
          type: "function" as const,
          function: {
            name: part.name,
            arguments: JSON.stringify(part.args ?? {}),
          },
        }));

      if (text.length === 0 && toolCalls.length === 0) continue;

      const assistant: ModelMessage = {
        role: "assistant",
        content: text.length > 0 ? text : "",
      };
      if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
      result.push(assistant);
      continue;
    }

    const text = message.content
      .filter(
        (part): part is Extract<LLMMessage["content"][number], { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("");

    const toolResults = message.content.filter(
      (part): part is Extract<LLMMessage["content"][number], { type: "tool-result" }> =>
        part.type === "tool-result",
    );

    if (toolResults.length > 0) {
      if (text.length > 0) {
        result.push({ role: "user", content: text });
      }
      for (const tr of toolResults) {
        result.push({
          role: "tool",
          toolCallId: tr.id,
          content: tr.content,
        });
      }
      continue;
    }

    if (text.length > 0) {
      result.push({ role: "user", content: text });
    }
  }

  return result;
}

export function llmToolsToTanStackToolDefinitions(tools: LLMRequest["tools"]) {
  return tools.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters as JSONSchema,
  }));
}

function finishTokens(usage: { promptTokens?: number; completionTokens?: number } | undefined): {
  input: number;
  output: number;
} {
  if (!usage) return { input: 0, output: 0 };
  return { input: usage.promptTokens ?? 0, output: usage.completionTokens ?? 0 };
}

export async function* tanStackAGUIStreamToLLMStream(
  stream: AsyncIterable<TanStackStreamEvent>,
): AsyncIterable<LLMStreamEvent> {
  let finishSeen = false;

  for await (const event of stream) {
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
        if (event.delta) yield { type: "text-delta", text: event.delta };
        break;
      case "STEP_FINISHED":
        if (event.delta) yield { type: "reasoning-delta", text: event.delta };
        break;
      case "TOOL_CALL_END":
        yield {
          type: "tool-call",
          id: event.toolCallId,
          name: event.toolName,
          args: event.input ?? {},
        };
        break;
      case "RUN_FINISHED":
        finishSeen = true;
        yield {
          type: "finish",
          reason: event.finishReason != null ? String(event.finishReason) : "unknown",
          tokens: finishTokens(event.usage),
        };
        break;
      case "RUN_ERROR":
        yield { type: "error", error: new Error(event.error.message) };
        return;
      default:
        break;
    }
  }

  if (!finishSeen) {
    yield { type: "finish", reason: "unknown", tokens: { input: 0, output: 0 } };
  }
}

export function createTanStackTextProvider(
  options: TanStackTextProviderOptions,
): LLMProviderWithModel {
  return {
    model: resolveModelInfo(options),
    llm: {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        const messages = llmMessagesToTanStackModelMessages(request.messages);

        const aguiStream = options.adapter.chatStream({
          model: options.adapter.model,
          messages,
          systemPrompts: request.system.trim().length > 0 ? [request.system] : undefined,
          tools:
            request.tools.length > 0 ? llmToolsToTanStackToolDefinitions(request.tools) : undefined,
          temperature: request.temperature,
          maxTokens: request.maxOutputTokens,
          request: request.signal ? { signal: request.signal } : undefined,
          modelOptions: request.providerOptions as object | undefined,
        });

        yield* tanStackAGUIStreamToLLMStream(aguiStream as AsyncIterable<TanStackStreamEvent>);
      },
    },
  };
}
