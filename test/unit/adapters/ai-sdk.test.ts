import { describe, expect, test } from "bun:test";
import {
  aiSDKStreamToLLMStream,
  llmMessagesToAISDKMessages,
  llmToolsToAISDKTools,
} from "../../../src/adapters/ai-sdk.ts";
import type { LLMMessage, LLMRequest } from "../../../src/llm.ts";

describe("llmMessagesToAISDKMessages", () => {
  test("converts assistant tool calls and tool results", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking..." },
          { type: "tool-call", id: "call-1", name: "read", args: { path: "/note.txt" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool-result", id: "call-1", content: "hello" }],
      },
    ];

    const result = llmMessagesToAISDKMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "Checking..." },
        { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "/note.txt" } },
      ],
    });
    expect(result[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read",
          output: { type: "text", value: "hello" },
        },
      ],
    });
  });
});

describe("llmToolsToAISDKTools", () => {
  test("builds a keyed tool record", () => {
    const tools: LLMRequest["tools"] = [
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];

    const result = llmToolsToAISDKTools(tools);

    expect(Object.keys(result)).toEqual(["read"]);
  });
});

describe("aiSDKStreamToLLMStream", () => {
  test("maps AI SDK stream events into harness events", async () => {
    async function* stream() {
      yield { type: "text-delta" as const, text: "hi" };
      yield { type: "reasoning-delta" as const, text: "thinking" };
      yield {
        type: "tool-call" as const,
        toolCallId: "call-1",
        toolName: "read",
        input: { path: "/note.txt" },
      };
      yield {
        type: "finish" as const,
        finishReason: "stop",
        totalUsage: { inputTokens: 10, outputTokens: 5 },
      };
      yield { type: "error" as const, error: "boom" };
    }

    const events = [];
    for await (const event of aiSDKStreamToLLMStream(stream())) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "reasoning-delta", text: "thinking" },
      { type: "tool-call", id: "call-1", name: "read", args: { path: "/note.txt" } },
      { type: "finish", reason: "stop", tokens: { input: 10, output: 5 } },
      { type: "error", error: new Error("boom") },
    ]);
  });
});
