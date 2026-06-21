import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import type {
  LLMMessage,
  LLMProviderWithModel,
  LLMRequest,
  LLMStreamEvent,
  ModelInfoInit,
} from "../llm.ts";
import { resolveModelInfo } from "../llm.ts";

export interface AISDKProviderOptions extends ModelInfoInit {
  model: Parameters<typeof streamText>[0]["model"];
}

export function llmMessagesToAISDKMessages(messages: LLMMessage[]): ModelMessage[] {
  const toolNameById = new Map<string, string>();
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const content = message.content
        .map((part) => {
          switch (part.type) {
            case "text":
              return { type: "text" as const, text: part.text };
            case "tool-call":
              toolNameById.set(part.id, part.name);
              return {
                type: "tool-call" as const,
                toolCallId: part.id,
                toolName: part.name,
                input: part.args,
              };
            default:
              return null;
          }
        })
        .filter((part): part is NonNullable<typeof part> => part != null);

      result.push({
        role: "assistant",
        content,
      } satisfies ModelMessage);
      continue;
    }

    const textContent = message.content
      .filter(
        (part): part is Extract<LLMMessage["content"][number], { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => ({ type: "text" as const, text: part.text }));
    const toolResults = message.content
      .filter(
        (part): part is Extract<LLMMessage["content"][number], { type: "tool-result" }> =>
          part.type === "tool-result",
      )
      .map((part) => ({
        type: "tool-result" as const,
        toolCallId: part.id,
        toolName: toolNameById.get(part.id) ?? "unknown",
        output: { type: "text" as const, value: part.content },
        isError: part.isError,
      }));

    if (toolResults.length > 0 && textContent.length === 0) {
      result.push({
        role: "tool",
        content: toolResults,
      } satisfies ModelMessage);
      continue;
    }

    result.push({
      role: "user",
      content: textContent,
    } satisfies ModelMessage);
  }

  return result;
}

export function llmToolsToAISDKTools(tools: LLMRequest["tools"]) {
  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters),
      }),
    ]),
  );
}

export async function* aiSDKStreamToLLMStream<TOOLS extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
): AsyncIterable<LLMStreamEvent> {
  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        yield { type: "text-delta", text: part.text };
        break;
      case "reasoning-delta":
        yield { type: "reasoning-delta", text: part.text };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          args: part.input,
        };
        break;
      case "finish":
        yield {
          type: "finish",
          reason: part.finishReason,
          tokens: {
            input: part.totalUsage.inputTokens ?? 0,
            output: part.totalUsage.outputTokens ?? 0,
          },
        };
        break;
      case "error":
        yield {
          type: "error",
          error: part.error instanceof Error ? part.error : new Error(String(part.error)),
        };
        break;
      default:
        break;
    }
  }
}

export function createAISDKProvider(options: AISDKProviderOptions): LLMProviderWithModel {
  return {
    model: resolveModelInfo(options),
    llm: {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        const result = streamText({
          model: options.model,
          system: request.system,
          messages: llmMessagesToAISDKMessages(request.messages),
          tools: llmToolsToAISDKTools(request.tools),
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
          providerOptions: request.providerOptions as
            | Parameters<typeof streamText>[0]["providerOptions"]
            | undefined,
          stopWhen: stepCountIs(1),
          abortSignal: request.signal,
        });

        yield* aiSDKStreamToLLMStream(result.fullStream);
      },
    },
  };
}
