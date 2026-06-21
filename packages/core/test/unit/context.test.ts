import { describe, test, expect, beforeEach } from "bun:test";
import {
  DEFAULT_COMPACTION_SYSTEM_PROMPT,
  defaultCompactionStrategy,
  estimateTokens,
  runContextPipeline,
  shouldCompact,
} from "../../src/context.ts";
import type { CompactionContext, ContextTransform } from "../../src/tool/types.ts";
import type { Message } from "../../src/types.ts";
import {
  createMockLLM,
  resetIds,
  userMsg,
  assistantMsg,
  assistantWithTools,
  completedToolCall,
  errorToolCall,
} from "../test-helpers.ts";

beforeEach(() => resetIds());

// ── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  test("returns 0 for empty messages", () => {
    expect(estimateTokens([])).toBe(0);
  });

  test("estimates tokens for a simple text message", () => {
    // "Hello" = 5 chars → ceil(5/4) = 2 tokens
    const messages: Message[] = [userMsg("Hello")];
    expect(estimateTokens(messages)).toBe(2);
  });

  test("accumulates across multiple messages", () => {
    // "Hello" (5) + "World" (5) = 10 chars → ceil(10/4) = 3
    const messages: Message[] = [userMsg("Hello"), assistantMsg("World")];
    expect(estimateTokens(messages)).toBe(3);
  });

  test("counts tool call input and output", () => {
    const tc = completedToolCall("read", { path: "/foo" }, "file content here");
    const messages: Message[] = [assistantWithTools([tc])];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  test("counts error tool call messages", () => {
    const tc = errorToolCall("bash", { command: "fail" }, "Command failed with exit code 1");
    const messages: Message[] = [assistantWithTools([tc])];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  test("counts file parts by path and mime", () => {
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "file", path: "/path/to/image.png", mime: "image/png" }],
        model: { provider: "test", model: "mock-1" },
      },
    ];
    const tokens = estimateTokens(messages);
    // "/path/to/image.png" (18) + "image/png" (9) = 27 chars → ceil(27/4) = 7
    expect(tokens).toBe(7);
  });

  test("counts reasoning parts", () => {
    const messages: Message[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think step by step..." }],
        model: { provider: "test", model: "mock-1" },
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  test("handles object input in tool calls by serializing to JSON", () => {
    const tc = completedToolCall("edit", { path: "/f.ts", edits: [{ old: "a", new: "b" }] }, "ok");
    const messages: Message[] = [assistantWithTools([tc])];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  test("handles string input in tool calls directly", () => {
    const tc = completedToolCall("bash", "ls -la", "total 8\n...");
    const messages: Message[] = [assistantWithTools([tc])];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ── shouldCompact ───────────────────────────────────────────────────────────

describe("shouldCompact", () => {
  test("returns false when well under the threshold", () => {
    const messages: Message[] = [userMsg("Hi")];
    expect(shouldCompact(messages, 100_000)).toBe(false);
  });

  test("returns true when over the threshold", () => {
    const longText = "x".repeat(400_000); // 400k chars → ~100k tokens
    const messages: Message[] = [userMsg(longText)];
    // 100k tokens > 100k * 0.8 = 80k → should compact
    expect(shouldCompact(messages, 100_000)).toBe(true);
  });

  test("respects custom threshold", () => {
    // 20 chars → 5 tokens, contextLimit=10, threshold=0.4 → 10*0.4=4 → 5>4 = true
    const messages: Message[] = [userMsg("12345678901234567890")];
    expect(shouldCompact(messages, 10, 0.4)).toBe(true);
  });

  test("returns false at exactly the boundary", () => {
    // 32 chars → ceil(32/4) = 8 tokens, limit=10, threshold=0.8 → 10*0.8=8 → 8>8 = false
    const messages: Message[] = [userMsg("a".repeat(32))];
    expect(shouldCompact(messages, 10, 0.8)).toBe(false);
  });
});

// ── defaultCompactionStrategy ───────────────────────────────────────────────

describe("defaultCompactionStrategy", () => {
  test("summarizes earlier history and preserves the latest user turn onward", async () => {
    const requests: string[] = [];
    const llm = createMockLLM((request) => {
      requests.push(request.system);
      return [
        { type: "text-delta", text: "summary of the earlier exchange" },
        { type: "finish", reason: "end-turn", tokens: { input: 3, output: 1 } },
      ];
    });
    const messages: Message[] = [
      userMsg("earlier question"),
      assistantMsg("earlier answer"),
      userMsg("latest question"),
      assistantMsg("tool result follow-up"),
    ];
    const ctx: CompactionContext = {
      sessionId: "session-1",
      llm,
      model: {
        id: "test:mock-1",
        name: "Mock 1",
        contextLimit: 8_000,
        outputLimit: 2_000,
        capabilities: { reasoning: true, toolCalls: true, images: false },
      },
      signal: new AbortController().signal,
      reason: "proactive",
      summarySystemPrompt: DEFAULT_COMPACTION_SYSTEM_PROMPT,
    };

    const result = await defaultCompactionStrategy(messages, ctx);

    expect(requests).toEqual([DEFAULT_COMPACTION_SYSTEM_PROMPT]);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "[Compacted summary]\nsummary of the earlier exchange" }],
    });
    expect(result.slice(1)).toEqual(messages.slice(2));
  });
});

// ── runContextPipeline ──────────────────────────────────────────────────────

describe("runContextPipeline", () => {
  test("pass-through with no transform yields same as toLLMMessages", () => {
    const messages: Message[] = [userMsg("Hello"), assistantMsg("Hi")];
    return runContextPipeline(messages).then((result) => {
      expect(result).toHaveLength(2);
      expect(result[0]!.role).toBe("user");
      expect(result[1]!.role).toBe("assistant");
    });
  });

  test("applies a custom transform before conversion", async () => {
    const messages: Message[] = [userMsg("Hello"), userMsg("World")];

    const onlyFirst: ContextTransform = async (msgs) => [msgs[0]!];

    const result = await runContextPipeline(messages, { transform: onlyFirst });
    expect(result).toHaveLength(1);
    expect(result[0]!.content[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("transform receives the abort signal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const spy: ContextTransform = async (msgs, signal) => {
      receivedSignal = signal;
      return msgs;
    };

    await runContextPipeline([userMsg("test")], {
      transform: spy,
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("handles empty message array", async () => {
    const result = await runContextPipeline([]);
    expect(result).toEqual([]);
  });

  test("transform can inject messages", async () => {
    const inject: ContextTransform = async (msgs) => [
      {
        id: "injected",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "[System context]" }],
        model: { provider: "test", model: "mock-1" },
        agent: "coder",
      },
      ...msgs,
    ];

    const result = await runContextPipeline([userMsg("Hello")], { transform: inject });
    expect(result).toHaveLength(2);
    expect(result[0]!.content[0]).toEqual({ type: "text", text: "[System context]" });
    expect(result[1]!.content[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("preserves tool call structure through pipeline", async () => {
    const tc = completedToolCall("read", { path: "/x" }, "data");
    const messages: Message[] = [userMsg("Read x"), assistantWithTools([tc])];

    const result = await runContextPipeline(messages);

    expect(result).toHaveLength(3);
    expect(result[1]!.content[0]!.type).toBe("tool-call");
    expect(result[2]!.content[0]!.type).toBe("tool-result");
  });
});
