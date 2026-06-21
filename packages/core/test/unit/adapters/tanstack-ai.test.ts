import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import {
  llmMessagesToTanStackModelMessages,
  llmToolsToTanStackToolDefinitions,
  tanStackAGUIStreamToLLMStream,
} from "../../../src/adapters/tanstack-ai.ts";
import type { LLMMessage, LLMRequest } from "../../../src/llm.ts";

describe("llmMessagesToTanStackModelMessages", () => {
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

    const result = llmMessagesToTanStackModelMessages(messages);

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

describe("llmToolsToTanStackToolDefinitions", () => {
  test("builds tool definitions with names", () => {
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

    const result = llmToolsToTanStackToolDefinitions(tools);

    expect(result).toHaveLength(1);
    const [first] = result;
    expect(first?.name).toBe("read");
    expect(first?.description).toBe("Read a file");
  });
});

describe("tanStackAGUIStreamToLLMStream", () => {
  test("maps AG-UI events into harness events", async () => {
    const chunks = [
      { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
      {
        type: "TOOL_CALL_END",
        toolCallId: "t1",
        toolName: "read",
        input: { path: "/a" },
      },
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 1, completionTokens: 2 },
      },
    ] as unknown as StreamChunk[];

    async function* stream(): AsyncGenerator<StreamChunk> {
      for (const chunk of chunks) yield chunk;
    }

    const events = [];
    for await (const e of tanStackAGUIStreamToLLMStream(stream())) {
      events.push(e);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "tool-call", id: "t1", name: "read", args: { path: "/a" } },
      {
        type: "finish",
        reason: "tool_calls",
        tokens: { input: 1, output: 2 },
      },
    ]);
  });

  test("emits finish when stream ends without RUN_FINISHED", async () => {
    async function* stream(): AsyncGenerator<StreamChunk> {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "x" } as unknown as StreamChunk;
    }

    const events = [];
    for await (const e of tanStackAGUIStreamToLLMStream(stream())) {
      events.push(e);
    }

    expect(events[events.length - 1]).toEqual({
      type: "finish",
      reason: "unknown",
      tokens: { input: 0, output: 0 },
    });
  });
});
