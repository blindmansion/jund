import { describe, test, expect, beforeEach } from "bun:test";
import { toLLMMessages } from "../../src/llm.ts";
import type { LLMContent } from "../../src/llm.ts";
import type { Message } from "../../src/types.ts";
import {
  resetIds,
  userMsg,
  assistantMsg,
  assistantWithTools,
  completedToolCall,
  errorToolCall,
  pendingToolCall,
  runningToolCall,
  createMockLLM,
  textResponse,
  toolCallResponse,
} from "../test-helpers.ts";

beforeEach(() => resetIds());

// ── toLLMMessages ───────────────────────────────────────────────────────────

describe("toLLMMessages", () => {
  test("converts a single user text message", () => {
    const messages: Message[] = [userMsg("Hello")];
    const result = toLLMMessages(messages);

    expect(result).toEqual([{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
  });

  test("converts a single assistant text message", () => {
    const messages: Message[] = [assistantMsg("Hi there")];
    const result = toLLMMessages(messages);

    expect(result).toEqual([{ role: "assistant", content: [{ type: "text", text: "Hi there" }] }]);
  });

  test("converts a multi-turn conversation", () => {
    const messages: Message[] = [
      userMsg("What is 2+2?"),
      assistantMsg("4"),
      userMsg("And 3+3?"),
      assistantMsg("6"),
    ];
    const result = toLLMMessages(messages);

    expect(result).toHaveLength(4);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
    expect(result[2]!.role).toBe("user");
    expect(result[3]!.role).toBe("assistant");
  });

  test("converts completed tool calls into assistant + user (tool-result) pair", () => {
    const tc = completedToolCall("read", { path: "/foo.txt" }, "file contents");
    const messages: Message[] = [userMsg("Read foo.txt"), assistantWithTools([tc])];
    const result = toLLMMessages(messages);

    expect(result).toHaveLength(3);

    // User message
    expect(result[0]!.role).toBe("user");

    // Assistant message with tool-call
    const assistantContent = result[1]!.content;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]!.type).toBe("tool-call");
    const call = assistantContent[0] as Extract<LLMContent, { type: "tool-call" }>;
    expect(call.name).toBe("read");
    expect(call.args).toEqual({ path: "/foo.txt" });

    // Tool result message (role: user)
    expect(result[2]!.role).toBe("user");
    const resultContent = result[2]!.content;
    expect(resultContent).toHaveLength(1);
    expect(resultContent[0]!.type).toBe("tool-result");
    const tr = resultContent[0] as Extract<LLMContent, { type: "tool-result" }>;
    expect(tr.content).toBe("file contents");
    expect(tr.isError).toBeUndefined();
  });

  test("converts error tool calls with isError flag", () => {
    const tc = errorToolCall("bash", { command: "rm -rf /" }, "Permission denied");
    const messages: Message[] = [assistantWithTools([tc])];
    const result = toLLMMessages(messages);

    const toolResult = result[1]!.content[0] as Extract<LLMContent, { type: "tool-result" }>;
    expect(toolResult.content).toBe("Permission denied");
    expect(toolResult.isError).toBe(true);
  });

  test("converts pending tool calls as incomplete errors", () => {
    const tc = pendingToolCall("read", { path: "/foo" });
    const messages: Message[] = [assistantWithTools([tc])];
    const result = toLLMMessages(messages);

    const toolResult = result[1]!.content[0] as Extract<LLMContent, { type: "tool-result" }>;
    expect(toolResult.content).toBe("[Tool execution incomplete]");
    expect(toolResult.isError).toBe(true);
  });

  test("converts running tool calls as incomplete errors", () => {
    const tc = runningToolCall("bash", { command: "sleep 100" });
    const messages: Message[] = [assistantWithTools([tc])];
    const result = toLLMMessages(messages);

    const toolResult = result[1]!.content[0] as Extract<LLMContent, { type: "tool-result" }>;
    expect(toolResult.content).toBe("[Tool execution incomplete]");
    expect(toolResult.isError).toBe(true);
  });

  test("handles multiple tool calls in one assistant message", () => {
    const tc1 = completedToolCall("read", { path: "/a.txt" }, "aaa");
    const tc2 = completedToolCall("read", { path: "/b.txt" }, "bbb");
    const messages: Message[] = [assistantWithTools([tc1, tc2], "Let me read both files.")];
    const result = toLLMMessages(messages);

    // assistant message: text + 2 tool-calls
    const assistantContent = result[0]!.content;
    expect(assistantContent).toHaveLength(3);
    expect(assistantContent[0]!.type).toBe("text");
    expect(assistantContent[1]!.type).toBe("tool-call");
    expect(assistantContent[2]!.type).toBe("tool-call");

    // tool results message: 2 results
    const resultContent = result[1]!.content;
    expect(resultContent).toHaveLength(2);
    expect(resultContent[0]!.type).toBe("tool-result");
    expect(resultContent[1]!.type).toBe("tool-result");
  });

  test("strips reasoning parts from assistant messages", () => {
    const messages: Message[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Let me think about this..." },
          { type: "text", text: "The answer is 42." },
        ],
        agent: "coder",
        model: { provider: "test", model: "mock-1" },
        finishReason: "end-turn",
      },
    ];
    const result = toLLMMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toHaveLength(1);
    expect(result[0]!.content[0]!.type).toBe("text");
  });

  test("skips file parts in user messages", () => {
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "file", path: "/img.png", mime: "image/png" },
          { type: "text", text: "What is this?" },
        ],
        model: { provider: "test", model: "mock-1" },
        agent: "coder",
      },
    ];
    const result = toLLMMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toHaveLength(1);
    expect(result[0]!.content[0]!.type).toBe("text");
  });

  test("skips user messages with no convertible content", () => {
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "file", path: "/img.png", mime: "image/png" }],
        model: { provider: "test", model: "mock-1" },
        agent: "coder",
      },
    ];
    const result = toLLMMessages(messages);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for empty input", () => {
    expect(toLLMMessages([])).toEqual([]);
  });

  test("full round-trip conversation with tool calls", () => {
    const tc1 = completedToolCall("read", { path: "/src/main.ts" }, "export function main() {}");
    const tc2 = completedToolCall("bash", { command: "ls" }, "main.ts\nutil.ts");

    const messages: Message[] = [
      userMsg("Explore the project"),
      assistantWithTools([tc1, tc2], "I'll read the source and list files."),
      assistantMsg("The project has main.ts and util.ts."),
    ];

    const result = toLLMMessages(messages);

    expect(result).toHaveLength(4);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
    expect(result[2]!.role).toBe("user"); // tool results
    expect(result[3]!.role).toBe("assistant"); // final text
  });
});

// ── Mock LLM provider ──────────────────────────────────────────────────────

describe("createMockLLM", () => {
  test("yields text response events", async () => {
    const llm = createMockLLM(() => textResponse("Hello world"));
    const events: string[] = [];

    for await (const event of llm.stream({
      system: "test",
      messages: [],
      tools: [],
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["text-delta", "finish"]);
  });

  test("yields tool call events", async () => {
    const llm = createMockLLM(() =>
      toolCallResponse([{ id: "tc1", name: "read", args: { path: "/foo" } }]),
    );
    const events: string[] = [];

    for await (const event of llm.stream({
      system: "test",
      messages: [],
      tools: [],
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["tool-call", "finish"]);
  });

  test("receives the request object", async () => {
    let captured: unknown;
    const llm = createMockLLM((req) => {
      captured = req;
      return textResponse("ok");
    });

    const request = {
      system: "You are helpful",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      tools: [{ name: "read", description: "Read a file", parameters: {} }],
      temperature: 0.5,
    };

    // consume the stream
    for await (const _ of llm.stream(request)) {
      // noop
    }

    expect(captured).toEqual(request);
  });
});
