import { describe, expect, test } from "bun:test";
import type { ChatStreamChunk } from "@openrouter/sdk/models";
import {
  llmMessagesToOpenRouterMessages,
  llmToolsToOpenRouterTools,
  openRouterChatStreamToLLMStream,
} from "../../../src/adapters/openrouter-sdk.ts";
import type { LLMMessage, LLMRequest } from "../../../src/llm.ts";

describe("llmMessagesToOpenRouterMessages", () => {
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

    const result = llmMessagesToOpenRouterMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: "assistant",
      content: "Checking...",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: '{"path":"/note.txt"}' },
        },
      ],
    });
    expect(result[1]).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: "hello",
    });
  });
});

describe("llmToolsToOpenRouterTools", () => {
  test("builds OpenRouter function tools", () => {
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

    const result = llmToolsToOpenRouterTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: expect.objectContaining({
          type: "object",
          properties: { path: { type: "string" } },
        }),
      },
    });
  });
});

describe("openRouterChatStreamToLLMStream", () => {
  test("maps streaming chunks into harness events", async () => {
    async function* stream(): AsyncGenerator<ChatStreamChunk> {
      yield {
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "x",
        choices: [
          {
            index: 0,
            delta: { content: "hi" },
            finishReason: null,
            logprobs: null,
          },
        ],
      };
      yield {
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "x",
        choices: [
          {
            index: 0,
            delta: {
              toolCalls: [{ index: 0, id: "call-1", type: "function", function: { name: "read" } }],
            },
            finishReason: null,
            logprobs: null,
          },
        ],
      };
      yield {
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "x",
        choices: [
          {
            index: 0,
            delta: {
              toolCalls: [{ index: 0, function: { arguments: '{"path":"/a"}' } }],
            },
            finishReason: null,
            logprobs: null,
          },
        ],
      };
      yield {
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "x",
        choices: [
          {
            index: 0,
            delta: {},
            finishReason: "tool_calls",
            logprobs: null,
          },
        ],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      };
    }

    const events = [];
    for await (const e of openRouterChatStreamToLLMStream(stream())) {
      events.push(e);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      {
        type: "tool-call",
        id: "call-1",
        name: "read",
        args: { path: "/a" },
      },
      {
        type: "finish",
        reason: "tool_calls",
        tokens: { input: 1, output: 2 },
      },
    ]);
  });
});
