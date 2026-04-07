import type { OpenRouter } from "@openrouter/sdk";
import type {
  ChatAssistantMessage,
  ChatFunctionTool,
  ChatMessages,
  ChatStreamChunk,
  ChatStreamToolCall,
  ChatToolCall,
} from "@openrouter/sdk/models";
import type {
  LLMMessage,
  LLMProviderWithModel,
  LLMRequest,
  LLMStreamEvent,
  ModelInfoInit,
} from "../llm.ts";
import { resolveModelInfo } from "../llm.ts";

export interface OpenRouterProviderOptions extends ModelInfoInit {
  /** Configured OpenRouter client (API key, server URL, etc.). */
  client: OpenRouter;
  /** OpenRouter model id (e.g. `openai/gpt-4o-mini`). */
  model: string;
}

type ToolCallAccumulator = { id: string; name: string; arguments: string };

function mergeToolCallDelta(acc: ToolCallAccumulator, delta: ChatStreamToolCall): void {
  if (delta.id) acc.id = delta.id;
  if (delta.function?.name) acc.name += delta.function.name;
  if (delta.function?.arguments) acc.arguments += delta.function.arguments;
}

export function llmMessagesToOpenRouterMessages(messages: LLMMessage[]): ChatMessages[] {
  const result: ChatMessages[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter(
          (part): part is Extract<LLMMessage["content"][number], { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("");

      const toolCalls: ChatToolCall[] = message.content
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

      const assistant: ChatAssistantMessage = { role: "assistant" };
      if (text.length > 0) assistant.content = text;
      if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
      if (text.length > 0 || toolCalls.length > 0) result.push(assistant);
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

export function llmToolsToOpenRouterTools(tools: LLMRequest["tools"]): ChatFunctionTool[] {
  return tools.map((definition) => ({
    type: "function" as const,
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as { [k: string]: unknown },
    },
  }));
}

function finishTokens(usage: ChatStreamChunk["usage"]): { input: number; output: number } {
  if (!usage) return { input: 0, output: 0 };
  return { input: usage.promptTokens, output: usage.completionTokens };
}

export async function* openRouterChatStreamToLLMStream(
  stream: AsyncIterable<ChatStreamChunk>,
): AsyncIterable<LLMStreamEvent> {
  const toolCallsByIndex = new Map<number, ToolCallAccumulator>();
  let finishEmitted = false;
  let lastUsage: ChatStreamChunk["usage"];

  function* flushToolCalls(): Generator<LLMStreamEvent> {
    const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const acc = toolCallsByIndex.get(index);
      if (!acc || !acc.id || !acc.name) continue;
      let args: unknown = {};
      const raw = acc.arguments.trim();
      if (raw.length > 0) {
        try {
          args = JSON.parse(raw) as unknown;
        } catch {
          yield {
            type: "error",
            error: new Error(`Invalid tool arguments JSON for ${acc.name}: ${raw}`),
          };
          continue;
        }
      }
      yield { type: "tool-call", id: acc.id, name: acc.name, args };
    }
    toolCallsByIndex.clear();
  }

  try {
    for await (const chunk of stream) {
      if (chunk.error) {
        yield {
          type: "error",
          error: new Error(chunk.error.message),
        };
        return;
      }

      if (chunk.usage) lastUsage = chunk.usage;

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      if (delta.content) {
        yield { type: "text-delta", text: delta.content };
      }
      if (delta.reasoning) {
        yield { type: "reasoning-delta", text: delta.reasoning };
      }

      if (delta.toolCalls) {
        for (const tc of delta.toolCalls) {
          let acc = toolCallsByIndex.get(tc.index);
          if (!acc) {
            acc = { id: "", name: "", arguments: "" };
            toolCallsByIndex.set(tc.index, acc);
          }
          mergeToolCallDelta(acc, tc);
        }
      }

      if (choice.finishReason != null && choice.finishReason !== undefined) {
        yield* flushToolCalls();
        finishEmitted = true;
        yield {
          type: "finish",
          reason: String(choice.finishReason),
          tokens: finishTokens(chunk.usage ?? lastUsage),
        };
      }
    }
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
    return;
  }

  if (!finishEmitted) {
    yield* flushToolCalls();
    yield { type: "finish", reason: "unknown", tokens: finishTokens(lastUsage) };
  }
}

export function createOpenRouterProvider(options: OpenRouterProviderOptions): LLMProviderWithModel {
  return {
    model: resolveModelInfo(options),
    llm: {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        const messages: ChatMessages[] = [];
        if (request.system.trim().length > 0) {
          messages.push({ role: "system", content: request.system });
        }
        messages.push(...llmMessagesToOpenRouterMessages(request.messages));

        const eventStream = await options.client.chat.send(
          {
            chatRequest: {
              ...(request.providerOptions as object | undefined),
              model: options.model,
              messages,
              stream: true,
              tools:
                request.tools.length > 0 ? llmToolsToOpenRouterTools(request.tools) : undefined,
              temperature: request.temperature ?? undefined,
              maxTokens: request.maxOutputTokens ?? undefined,
            },
          },
          { signal: request.signal },
        );

        yield* openRouterChatStreamToLLMStream(eventStream);
      },
    },
  };
}
