/**
 * Smoke tests that mirror every code example in README.md.
 *
 * These use mock LLM providers and in-memory environments so they run
 * without credentials or network access.
 */
import { describe, expect, test } from "bun:test";
import type { LLMProvider, LLMRequest, LLMStreamEvent, ModelInfo } from "../../src/llm.ts";
import type { Environment } from "../../src/types.ts";
import {
  createSession,
  getAssistantText,
  SessionPersistenceAdapter,
  MemoryStorage,
  estimateTokens,
  shouldCompact,
  runContextPipeline,
  callLLM,
  processTurn,
  buildSystemPrompt,
  ToolRegistry,
  FileMutationQueue,
  generateId,
  toLLMMessages,
  createCoderTools,
} from "../../src/index.ts";
import { Bash, ReadWriteFs } from "just-bash";
import { createAISDKProvider } from "../../src/adapters/ai-sdk.ts";
import { createOpenRouterProvider } from "../../src/adapters/openrouter-sdk.ts";
import { createTanStackTextProvider } from "../../src/adapters/tanstack-ai.ts";
import { createMockEnvironment } from "../test-helpers.ts";

function makeMockLLM(respond?: (req: LLMRequest) => LLMStreamEvent[]): LLMProvider {
  return {
    async *stream(request: LLMRequest) {
      const events = respond
        ? respond(request)
        : [
            { type: "text-delta" as const, text: "mock reply" },
            {
              type: "finish" as const,
              reason: "end-turn" as const,
              tokens: { input: 10, output: 5 },
            },
          ];
      yield* events;
    },
  };
}

const TEST_MODEL: ModelInfo = {
  id: "claude-sonnet",
  name: "claude-sonnet-4-20250514",
  contextLimit: 200_000,
  outputLimit: 64_000,
  capabilities: { reasoning: true, toolCalls: true, images: true },
};

// ── README: Quick start ─────────────────────────────────────────────────────

describe("README: Quick start", () => {
  test("createSession with just-bash environment + prompt + getAssistantText", async () => {
    const tmpDir = `${import.meta.dir}/../../.tmp/smoke-quick-start`;
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(`${tmpDir}/index.ts`, 'console.log("hello");\n');

    const fs = new ReadWriteFs({ root: tmpDir });
    const shell = new Bash({ fs, cwd: "/" });

    const session = await createSession({
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
      tools: createCoderTools({ fs, shell }, { workdir: "/" }),
      onEvent: (event) => {
        expect(event.type).toBeDefined();
      },
    });

    const reply = await session.prompt("Add a health-check endpoint to the server.");
    const text = getAssistantText(reply);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── README: LLM provider adapters ───────────────────────────────────────────

describe("README: LLM provider adapters", () => {
  test("createAISDKProvider returns { llm, model }", () => {
    const mockModel = { modelId: "mock", provider: "mock" } as any;
    const provider = createAISDKProvider({
      model: mockModel,
      id: "test-model",
      contextLimit: 200_000,
      outputLimit: 64_000,
      capabilities: { reasoning: true, toolCalls: true, images: false },
    });
    expect(provider.llm).toBeDefined();
    expect(typeof provider.llm.stream).toBe("function");
    expect(provider.model.id).toBe("test-model");
    expect(provider.model.name).toBe("test-model");
    expect(provider.model.contextLimit).toBe(200_000);
  });

  test("createOpenRouterProvider returns { llm, model }", () => {
    const mockClient = { chat: { completions: { create: () => {} } } } as any;
    const provider = createOpenRouterProvider({
      client: mockClient,
      model: "anthropic/claude-sonnet-4-20250514",
      id: "claude-sonnet",
      name: "claude-sonnet-4-20250514",
      contextLimit: 200_000,
      outputLimit: 64_000,
      capabilities: { reasoning: true, toolCalls: true, images: true },
    });
    expect(provider.llm).toBeDefined();
    expect(typeof provider.llm.stream).toBe("function");
    expect(provider.model.id).toBe("claude-sonnet");
    expect(provider.model.name).toBe("claude-sonnet-4-20250514");
  });

  test("createTanStackTextProvider returns { llm, model }", () => {
    const mockAdapter = { generate: () => {} } as any;
    const provider = createTanStackTextProvider({
      adapter: mockAdapter,
      id: "tanstack-model",
      contextLimit: 128_000,
      outputLimit: 32_000,
      capabilities: { reasoning: false, toolCalls: true, images: false },
    });
    expect(provider.llm).toBeDefined();
    expect(typeof provider.llm.stream).toBe("function");
    expect(provider.model.id).toBe("tanstack-model");
  });
});

// ── README: Environment ─────────────────────────────────────────────────────

describe("README: Environment", () => {
  test("Environment interface shape is satisfied by createMockEnvironment", () => {
    const env: Environment = createMockEnvironment({ "/project/hello.txt": "world" });

    expect(typeof env.fs.readFile).toBe("function");
    expect(typeof env.fs.writeFile).toBe("function");
    expect(typeof env.fs.mkdir).toBe("function");
    expect(typeof env.fs.exists).toBe("function");
    expect(typeof env.fs.stat).toBe("function");
    expect(typeof env.fs.readdir).toBe("function");
    expect(typeof env.shell.exec).toBe("function");
  });

  test("Environment fs and shell operations work", async () => {
    const env: Environment = createMockEnvironment({ "/project/hello.txt": "world" });

    expect(await env.fs.readFile("/project/hello.txt")).toBe("world");
    expect(await env.fs.exists("/project/hello.txt")).toBe(true);

    const result = await env.shell.exec("echo hello");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
    expect(result).toHaveProperty("exitCode");
  });
});

// ── README: Session interface ───────────────────────────────────────────────

describe("README: Session interface", () => {
  test("Session exposes all documented properties and methods", async () => {
    const session = await createSession({
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
    });

    expect(typeof session.id).toBe("string");
    expect(session.model).toEqual(TEST_MODEL);
    expect(typeof session.isStreaming).toBe("boolean");
    expect(typeof session.prompt).toBe("function");
    expect(typeof session.cancel).toBe("function");
    expect(typeof session.messages).toBe("function");
    expect(typeof session.branchFrom).toBe("function");
    expect(typeof session.addTool).toBe("function");
    expect(typeof session.removeTool).toBe("function");
    expect(typeof session.setTools).toBe("function");
    expect(typeof session.setLLM).toBe("function");
  });
});

// ── README: Events ──────────────────────────────────────────────────────────

describe("README: Events", () => {
  test("onEvent receives typed AgentEvents", async () => {
    const seen = new Set<string>();

    const session = await createSession({
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
      onEvent: (event) => {
        seen.add(event.type);
      },
    });

    await session.prompt("Hi");

    for (const expected of ["turn.start", "turn.end", "message.created", "text.delta", "done"]) {
      expect(seen.has(expected)).toBe(true);
    }
  });
});

// ── README: Context compaction ──────────────────────────────────────────────

describe("README: Context compaction", () => {
  test("compaction can be disabled", async () => {
    const session = await createSession({
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
      compaction: false,
    });

    const reply = await session.prompt("Hello");
    expect(getAssistantText(reply)).toBe("mock reply");
  });

  test("compaction accepts threshold and strategy options", async () => {
    let strategyCalled = false;

    const session = await createSession({
      llm: { llm: makeMockLLM(), model: { ...TEST_MODEL, contextLimit: 10 } },
      compaction: {
        threshold: 0.8,
        strategy: async (messages) => {
          strategyCalled = true;
          const latest = messages.findLast((m) => m.role === "user")!;
          return [
            {
              id: "summary",
              role: "assistant",
              parts: [{ type: "text", text: "summary" }],
              agent: "coder",
              model: { provider: "test", model: "mock" },
              finishReason: "end-turn",
            },
            latest,
          ];
        },
      },
    });

    await session.prompt("12345678901234567890");
    await session.prompt("trigger compaction");
    expect(strategyCalled).toBe(true);
  });
});

// ── README: Persistence ─────────────────────────────────────────────────────

describe("README: Persistence", () => {
  test("MemoryStorage with SessionPersistenceAdapter", async () => {
    const driver = new MemoryStorage();
    const storage = new SessionPersistenceAdapter(driver);
    const session = await createSession({
      storage: driver,
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
    });

    await session.prompt("Hello");

    const stored = await storage.loadSession(session.id);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(session.id);

    const messages = await storage.loadVisibleMessages(session.id);
    expect(messages).toEqual(session.messages());
  });
});

// ── README: Lower-level primitives ──────────────────────────────────────────

describe("README: Lower-level primitives", () => {
  test("callLLM streams a single LLM call", async () => {
    const message = {
      id: generateId(),
      role: "assistant" as const,
      parts: [] as any[],
      model: { provider: "test", model: "mock" },
    };

    const result = await callLLM({
      message,
      llm: makeMockLLM(),
      system: "You are helpful.",
      messages: [],
      tools: [],
      abort: new AbortController().signal,
      sessionId: "test",
      emit: () => {},
    });

    expect(result.role).toBe("assistant");
    expect(result.parts.length).toBeGreaterThan(0);
  });

  test("processTurn runs one model step", async () => {
    const userMsg = {
      id: "u1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Hi" }],
      model: { provider: "test", model: "mock" },
    };

    const result = await processTurn({
      llm: makeMockLLM(),
      system: "You are helpful.",
      messages: toLLMMessages([userMsg]),
      tools: [],
      toolMap: new Map(),
      sessionId: "test",
      model: { provider: "test", model: "mock" },
      abort: new AbortController().signal,
      emit: () => {},
      queue: new FileMutationQueue(),
    });

    expect(result).toBeDefined();
    expect(result.role).toBe("assistant");
  });

  test("buildSystemPrompt assembles a prompt", () => {
    const prompt = buildSystemPrompt({
      base: "You are a helpful assistant.",
      tools: [],
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("ToolRegistry manages tool definitions", () => {
    const registry = new ToolRegistry();
    expect(typeof registry.add).toBe("function");
    expect(typeof registry.remove).toBe("function");
    expect(typeof registry.list).toBe("function");
    expect(typeof registry.get).toBe("function");
  });

  test("estimateTokens / shouldCompact / runContextPipeline", () => {
    expect(typeof estimateTokens).toBe("function");
    expect(typeof shouldCompact).toBe("function");
    expect(typeof runContextPipeline).toBe("function");

    const tokens = estimateTokens([]);
    expect(tokens).toBe(0);

    const compact = shouldCompact([], 1000);
    expect(compact).toBe(false);
  });
});

// ── README: createSession options ───────────────────────────────────────────

describe("README: createSession options", () => {
  test("toolExecution: parallel", async () => {
    const session = await createSession({
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
      toolExecution: "parallel",
    });

    const reply = await session.prompt("Hello");
    expect(getAssistantText(reply)).toBe("mock reply");
  });

  test("toolExecution: sequential", async () => {
    const session = await createSession({
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
      toolExecution: "sequential",
    });

    const reply = await session.prompt("Hello");
    expect(getAssistantText(reply)).toBe("mock reply");
  });

  test("retry option", async () => {
    let attempts = 0;
    const llm: LLMProvider = {
      stream() {
        attempts++;
        return (async function* () {
          if (attempts === 1) {
            throw Object.assign(new Error("429"), { status: 429 });
          }
          yield { type: "text-delta" as const, text: "recovered" };
          yield {
            type: "finish" as const,
            reason: "end-turn" as const,
            tokens: { input: 1, output: 1 },
          };
        })();
      },
    };

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      retry: { maxAttempts: 2, maxDelayMs: 0 },
    });

    const reply = await session.prompt("Hello");
    expect(attempts).toBe(2);
    expect(getAssistantText(reply)).toBe("recovered");
  });

  test("systemPrompt option", async () => {
    const seenSystems: string[] = [];
    const llm = makeMockLLM((req) => {
      if (req.system) seenSystems.push(req.system);
      return [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      systemPrompt: "You are a helpful coding assistant.",
    });

    await session.prompt("Hi");
    expect(seenSystems.length).toBeGreaterThan(0);
    expect(seenSystems[0]).toContain("You are a helpful coding assistant.");
  });

  test("lifecycle hooks are accepted", async () => {
    const hooksCalled = new Set<string>();

    const session = await createSession({
      llm: { llm: makeMockLLM(), model: TEST_MODEL },
      beforeInput: async () => {
        hooksCalled.add("beforeInput");
        return undefined;
      },
      beforeToolCall: async () => {
        hooksCalled.add("beforeToolCall");
        return undefined;
      },
      afterToolCall: async () => {
        hooksCalled.add("afterToolCall");
        return undefined;
      },
      beforeLLMCall: async () => {
        hooksCalled.add("beforeLLMCall");
        return undefined;
      },
      beforePrompt: async () => {
        hooksCalled.add("beforePrompt");
        return undefined;
      },
      transformContext: async (msgs) => {
        hooksCalled.add("transformContext");
        return msgs;
      },
    });

    await session.prompt("Hi");
    expect(hooksCalled.has("beforeInput")).toBe(true);
    expect(hooksCalled.has("beforeLLMCall")).toBe(true);
    expect(hooksCalled.has("beforePrompt")).toBe(true);
    expect(hooksCalled.has("transformContext")).toBe(true);
  });
});
