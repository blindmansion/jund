import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createSession,
  readSession,
  listSessions,
  listBranches,
  getSessionInfo,
  type Session,
} from "../../src/session.ts";
import type { AgentEvent } from "../../src/events.ts";
import type { LLMProvider, LLMRequest, LLMStreamEvent } from "../../src/llm.ts";
import type { CompactionStrategy, ToolDef } from "../../src/tool/types.ts";
import type { Message } from "../../src/types.ts";
import { createMockEnvironment } from "../test-helpers.ts";
import { createCoderTools } from "../../src/tool/coder.ts";
import { createReadTool } from "../../src/tool/read.ts";
import { getAssistantText } from "../../src/util/message.ts";
import { SessionPersistenceAdapter, MemoryStorage } from "../../src/storage/index.ts";
import type { Session as StorageSession } from "../../src/storage/types.ts";

const TEST_MODEL = {
  id: "test:mock-1",
  name: "Mock 1",
  contextLimit: 8_000,
  outputLimit: 2_000,
  capabilities: { reasoning: true, toolCalls: true, images: false },
} as const;

const TEST_MODEL_2 = {
  id: "test:mock-2",
  name: "Mock 2",
  contextLimit: 16_000,
  outputLimit: 4_000,
  capabilities: { reasoning: true, toolCalls: true, images: false },
} as const;

const SMALL_CONTEXT_MODEL = {
  id: "test:small-context",
  name: "Small Context",
  contextLimit: 10,
  outputLimit: 2_000,
  capabilities: { reasoning: true, toolCalls: true, images: false },
} as const;

function makeLLM(respond: (request: LLMRequest) => LLMStreamEvent[]): LLMProvider {
  return {
    async *stream(request: LLMRequest) {
      yield* respond(request);
    },
  };
}

function makeExtraTool(id: string): ToolDef {
  return {
    id,
    description: `${id} tool`,
    parameters: z.object({ value: z.string().optional() }),
    promptSnippet: `${id} - extra tool`,
    async execute() {
      return { output: id };
    },
  };
}

function makeValueTool(id: string): ToolDef<{ value: string }> {
  return {
    id,
    description: `${id} tool`,
    parameters: z.object({ value: z.string() }),
    promptSnippet: `${id} - value tool`,
    async execute(params) {
      return { output: `value:${params.value}` };
    },
  };
}

function textParts(request: LLMRequest): string[] {
  return request.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

function lastUserText(request: LLMRequest): string {
  for (const message of [...request.messages].reverse()) {
    for (const part of [...message.content].reverse()) {
      if (part.type === "text") {
        return part.text;
      }
    }
  }
  return "none";
}

function toolResultTexts(request: LLMRequest): string[] {
  return request.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "tool-result" ? [part.content] : [])),
  );
}

function makeReadOverrideTool(output: string): ToolDef<{ path: string }> {
  return {
    id: "read",
    description: "override read tool",
    parameters: z.object({ path: z.string() }),
    promptSnippet: "read - override tool",
    async execute() {
      return { output };
    },
  };
}

function compactedSummary(text: string): Message {
  return {
    id: `summary-${text}`,
    role: "assistant",
    parts: [{ type: "text", text }],
    model: { provider: "test", model: "small-context" },
    finishReason: "end-turn",
  };
}

describe("createSession", () => {
  test("runs a multi-step tool loop end to end", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello from file" });
    const llm = makeLLM((request) => {
      const hasToolResult = request.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result"),
      );

      if (!hasToolResult) {
        return [
          {
            type: "tool-call",
            id: "call-1",
            name: "read",
            args: { path: "file.txt" },
          },
          { type: "finish", reason: "tool-calls", tokens: { input: 10, output: 5 } },
        ];
      }

      return [
        { type: "text-delta", text: "The file says hello from file." },
        { type: "finish", reason: "end-turn", tokens: { input: 20, output: 7 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
    });

    const result = await session.prompt("Read file.txt and summarize it.");

    expect(result.finishReason).toBe("end-turn");
    expect(result.parts).toEqual([{ type: "text", text: "The file says hello from file." }]);
    expect(session.messages()).toHaveLength(3);

    const firstAssistant = session.messages()[1];
    expect(firstAssistant?.role).toBe("assistant");
    if (firstAssistant?.role === "assistant") {
      const toolPart = firstAssistant.parts[0] as Extract<
        (typeof firstAssistant.parts)[number],
        { type: "tool" }
      >;
      expect(toolPart.tool).toBe("read");
      expect(toolPart.state.status).toBe("completed");
    }
  });

  test("a host-authored task tool delegates to a child session", async () => {
    const env = createMockEnvironment({ "/project/note.txt": "hello from child" });
    const seenToolLists: string[][] = [];
    const llm = makeLLM((request) => {
      const toolNames = request.tools.map((tool) => tool.name);
      const hasToolResult = request.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result"),
      );
      seenToolLists.push(toolNames);

      if (toolNames.includes("task")) {
        if (!hasToolResult) {
          return [
            {
              type: "tool-call",
              id: "task-1",
              name: "task",
              args: {
                prompt: "Read note.txt and answer with just the file contents.",
              },
            },
            { type: "finish", reason: "tool-calls", tokens: { input: 5, output: 5 } },
          ];
        }

        expect(toolResultTexts(request)).toContain("hello from child");
        return [
          { type: "text-delta", text: "Parent got: hello from child" },
          { type: "finish", reason: "end-turn", tokens: { input: 5, output: 5 } },
        ];
      }

      expect(toolNames).toEqual(["read"]);
      if (!hasToolResult) {
        return [
          { type: "tool-call", id: "read-1", name: "read", args: { path: "note.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 5, output: 5 } },
        ];
      }

      return [
        { type: "text-delta", text: "hello from child" },
        { type: "finish", reason: "end-turn", tokens: { input: 5, output: 5 } },
      ];
    });

    const taskTool: ToolDef<{ prompt: string }> = {
      id: "task",
      description: "Delegate a read-only lookup to a child agent.",
      parameters: z.object({ prompt: z.string() }),
      async execute({ prompt }) {
        const child = await createSession({
          llm: { llm, model: TEST_MODEL },
          tools: [createReadTool(env, { workdir: "/project" })],
        });
        const reply = await child.prompt(prompt);
        if (reply.error) throw reply.error;
        return { output: getAssistantText(reply) };
      },
    };

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: [taskTool],
    });

    const result = await session.prompt("Use a subagent.");

    expect(result.parts).toEqual([{ type: "text", text: "Parent got: hello from child" }]);
    expect(seenToolLists[0]).toContain("task");
    expect(seenToolLists[1]).toEqual(["read"]);
    expect(seenToolLists[2]).toEqual(["read"]);

    const parentTaskTurn = session.messages()[1];
    expect(parentTaskTurn?.role).toBe("assistant");
    if (parentTaskTurn?.role === "assistant") {
      const toolPart = parentTaskTurn.parts[0] as Extract<
        (typeof parentTaskTurn.parts)[number],
        { type: "tool" }
      >;
      expect(toolPart.tool).toBe("task");
      expect(toolPart.state).toEqual({
        status: "completed",
        output: "hello from child",
        duration: expect.any(Number),
      });
    }
  });

  test("a host task tool can wire parent cancellation to its child session", async () => {
    let childStarted!: () => void;
    const childStartedPromise = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const llm: LLMProvider = {
      stream(request) {
        const toolNames = request.tools.map((tool) => tool.name);
        const hasToolResult = request.messages.some((message) =>
          message.content.some((part) => part.type === "tool-result"),
        );

        return (async function* () {
          if (toolNames.includes("task")) {
            if (!hasToolResult) {
              yield {
                type: "tool-call" as const,
                id: "task-1",
                name: "task",
                args: { prompt: "Wait for cancellation." },
              };
              yield {
                type: "finish" as const,
                reason: "tool-calls",
                tokens: { input: 1, output: 1 },
              };
              return;
            }

            yield { type: "text-delta" as const, text: "Cancelled child task." };
            yield {
              type: "finish" as const,
              reason: "end-turn",
              tokens: { input: 1, output: 1 },
            };
            return;
          }

          childStarted();
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        })();
      },
    };

    const taskTool: ToolDef<{ prompt: string }> = {
      id: "task",
      description: "Delegate to a child agent, forwarding cancellation.",
      parameters: z.object({ prompt: z.string() }),
      async execute({ prompt }, ctx) {
        const child = await createSession({
          llm: { llm, model: TEST_MODEL },
          tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
        });
        const onAbort = () => child.cancel();
        if (ctx.abort.aborted) onAbort();
        else ctx.abort.addEventListener("abort", onAbort, { once: true });
        try {
          const reply = await child.prompt(prompt);
          if (reply.error) throw reply.error;
          return { output: getAssistantText(reply) };
        } finally {
          ctx.abort.removeEventListener("abort", onAbort);
        }
      },
    };

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: [taskTool],
    });

    const promptPromise = session.prompt("Use a cancellable subagent.");
    await childStartedPromise;
    session.cancel();
    const result = await promptPromise;

    expect(result.parts).toEqual([{ type: "text", text: "Cancelled child task." }]);
    const parentTaskTurn = session.messages()[1];
    expect(parentTaskTurn?.role).toBe("assistant");
    if (parentTaskTurn?.role === "assistant") {
      const toolPart = parentTaskTurn.parts[0] as Extract<
        (typeof parentTaskTurn.parts)[number],
        { type: "tool" }
      >;
      expect(toolPart.tool).toBe("task");
      expect(toolPart.state).toEqual({
        status: "error",
        error: "The request was aborted.",
        duration: expect.any(Number),
      });
    }
  });

  test("rebuilds the tool list on the next iteration after mutation", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    const seenToolLists: string[][] = [];
    const lateTool = makeExtraTool("lateTool");
    let session!: Session;

    const llm = makeLLM((request) => {
      seenToolLists.push(request.tools.map((tool) => tool.name));
      const hasToolResult = request.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result"),
      );
      if (!hasToolResult) {
        return [
          { type: "tool-call", id: "call-1", name: "read", args: { path: "file.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    let beforePromptCalls = 0;
    session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforePrompt: async () => {
        beforePromptCalls += 1;
        if (beforePromptCalls === 1) {
          session.addTool(lateTool);
        }
        return undefined;
      },
    });

    await session.prompt("Read file.txt.");

    expect(seenToolLists).toHaveLength(2);
    expect(seenToolLists[0]).not.toContain("lateTool");
    expect(seenToolLists[1]).toContain("lateTool");
  });

  test("retries a retryable llm stream failure before completing the turn", async () => {
    const env = createMockEnvironment();
    const events: AgentEvent[] = [];
    let attempts = 0;
    const llm: LLMProvider = {
      stream() {
        attempts += 1;
        return (async function* () {
          if (attempts === 1) {
            throw Object.assign(new Error("429 rate limit"), { status: 429 });
          }
          yield { type: "text-delta" as const, text: "retried ok" };
          yield { type: "finish" as const, reason: "end-turn", tokens: { input: 2, output: 1 } };
        })();
      },
    };

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      retry: { maxAttempts: 2, maxDelayMs: 0 },
      onEvent(event) {
        events.push(event);
      },
    });

    const result = await session.prompt("Say hi.");

    expect(attempts).toBe(2);
    expect(result.parts).toEqual([{ type: "text", text: "retried ok" }]);
    expect(events.some((event) => event.type === "retry")).toBe(true);
  });

  test("runs proactive compaction before transformContext and beforePrompt", async () => {
    const env = createMockEnvironment();
    const transformSeen: string[][] = [];
    const beforePromptSeen: string[][] = [];
    const reasons: string[] = [];
    const compaction: CompactionStrategy = async (messages, ctx) => {
      reasons.push(ctx.reason);
      const latestUser = messages.findLast((message) => message.role === "user")!;
      return [compactedSummary("[S]\ns"), latestUser];
    };
    let promptCalls = 0;
    const llm = makeLLM((request) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        return [
          { type: "text-delta", text: "first reply" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ];
      }
      expect(textParts(request)).toEqual(["[S]\ns", "latest question"]);
      return [
        { type: "text-delta", text: "after compaction" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: { strategy: compaction },
      transformContext: async (messages) => {
        transformSeen.push(
          messages.flatMap((message) =>
            message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
          ),
        );
        return messages;
      },
      beforePrompt: async ({ messages }) => {
        beforePromptSeen.push(
          messages.flatMap((message) =>
            message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
          ),
        );
        return undefined;
      },
    });

    await session.prompt("12345678901234567890");
    const result = await session.prompt("latest question");

    expect(reasons).toEqual(["proactive"]);
    expect(transformSeen.at(-1)).toEqual(["[S]\ns", "latest question"]);
    expect(beforePromptSeen.at(-1)).toEqual(["[S]\ns", "latest question"]);
    expect(result.parts).toEqual([{ type: "text", text: "after compaction" }]);
    expect(session.messages().map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("reactively compacts on context overflow and retries the same turn", async () => {
    const env = createMockEnvironment();
    const events: AgentEvent[] = [];
    const reasons: string[] = [];
    const compaction: CompactionStrategy = async (messages, ctx) => {
      reasons.push(ctx.reason);
      const latestUser = messages.findLast((message) => message.role === "user")!;
      return [compactedSummary("[S]\nr"), latestUser];
    };
    let promptCalls = 0;
    const llm: LLMProvider = {
      stream(request) {
        promptCalls += 1;
        return (async function* () {
          if (promptCalls === 1) {
            yield { type: "text-delta" as const, text: "first reply" };
            yield { type: "finish" as const, reason: "end-turn", tokens: { input: 1, output: 1 } };
            return;
          }
          if (!textParts(request).includes("[S]\nr")) {
            throw new Error("context window exceeded");
          }
          yield { type: "text-delta" as const, text: "after reactive compaction" };
          yield { type: "finish" as const, reason: "end-turn", tokens: { input: 1, output: 1 } };
        })();
      },
    };

    const session = await createSession({
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: { threshold: 2, strategy: compaction },
      onEvent(event) {
        events.push(event);
      },
    });

    await session.prompt("12345678901234567890");
    const result = await session.prompt("latest question");

    expect(reasons).toEqual(["reactive"]);
    expect(result.parts).toEqual([{ type: "text", text: "after reactive compaction" }]);
    expect(events.some((event) => event.type === "compaction")).toBe(true);
    expect(session.messages().map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("removeTool takes effect on the next iteration", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    const extraTool = makeExtraTool("extraTool");
    const seenToolLists: string[][] = [];
    let beforePromptCalls = 0;
    let session!: Session;

    const llm = makeLLM((request) => {
      seenToolLists.push(request.tools.map((tool) => tool.name));
      const hasToolResult = request.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result"),
      );
      if (!hasToolResult) {
        return [
          { type: "tool-call", id: "call-1", name: "read", args: { path: "file.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: [...createCoderTools(env, { workdir: "/project" }), extraTool],
      beforePrompt: async () => {
        beforePromptCalls += 1;
        if (beforePromptCalls === 1) {
          session.removeTool("extraTool");
        }
        return undefined;
      },
    });

    await session.prompt("Read file.txt.");

    expect(seenToolLists).toHaveLength(2);
    expect(seenToolLists[0]).toContain("extraTool");
    expect(seenToolLists[1]).not.toContain("extraTool");
    expect(session.getTools().map((tool) => tool.id)).not.toContain("extraTool");
  });

  test("setTools replaces the full tool set on the next iteration", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    const oldTool = makeExtraTool("oldTool");
    const newTool = makeExtraTool("newTool");
    const seenToolLists: string[][] = [];
    let beforePromptCalls = 0;
    let session!: Session;

    const llm = makeLLM((request) => {
      seenToolLists.push(request.tools.map((tool) => tool.name));
      const hasToolResult = request.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result"),
      );
      if (!hasToolResult) {
        return [
          { type: "tool-call", id: "call-1", name: "read", args: { path: "file.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: [...createCoderTools(env, { workdir: "/project" }), oldTool],
      beforePrompt: async () => {
        beforePromptCalls += 1;
        if (beforePromptCalls === 1) {
          session.setTools([newTool]);
        }
        return undefined;
      },
    });

    await session.prompt("Read file.txt.");

    expect(seenToolLists).toHaveLength(2);
    expect(seenToolLists[0]).toEqual(
      expect.arrayContaining(["read", "write", "edit", "bash", "oldTool"]),
    );
    expect(seenToolLists[1]).toEqual(["newTool"]);
    expect(seenToolLists[1]).not.toContain("oldTool");
    expect(seenToolLists[1]).not.toContain("read");
    expect(seenToolLists[1]).not.toContain("write");
    expect(seenToolLists[1]).not.toContain("edit");
    expect(seenToolLists[1]).not.toContain("bash");
    expect(session.getTools().map((tool) => tool.id)).toEqual(["newTool"]);
  });

  test("hook setters take effect on the next iteration", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    const lateTool = makeValueTool("lateTool");
    const beforeCalls: string[] = [];
    let llmCalls = 0;
    let session!: Session;

    const llm = makeLLM(() => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return [
          { type: "tool-call", id: "call-1", name: "read", args: { path: "file.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      if (llmCalls === 2) {
        return [
          { type: "tool-call", id: "call-2", name: "lateTool", args: { value: "later" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: [...createCoderTools(env, { workdir: "/project" }), lateTool],
      afterToolCall: async ({ toolName }) => {
        if (toolName === "read") {
          session.setBeforeToolCall(async ({ toolName, args }) => {
            beforeCalls.push(`${toolName}:${(args as { value: string }).value}`);
            return undefined;
          });
          session.setAfterToolCall(async ({ toolName, result }) => {
            if (toolName !== "lateTool") {
              return undefined;
            }
            return { output: `after:${result.output}` };
          });
        }
        return undefined;
      },
    });

    const result = await session.prompt("Read first, then use lateTool.");

    expect(result.parts).toEqual([{ type: "text", text: "done" }]);
    expect(beforeCalls).toEqual(["lateTool:later"]);

    const lateToolTurn = session.messages()[2];
    expect(lateToolTurn?.role).toBe("assistant");
    if (lateToolTurn?.role === "assistant") {
      const toolPart = lateToolTurn.parts[0] as Extract<
        (typeof lateToolTurn.parts)[number],
        { type: "tool" }
      >;
      expect(toolPart.tool).toBe("lateTool");
      expect(toolPart.state).toEqual({
        status: "completed",
        output: "after:value:later",
        duration: expect.any(Number),
      });
    }
  });

  test("setTransformContext, setBeforePrompt, and setLLM apply on the next iteration", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    let secondRequest: LLMRequest | undefined;
    let session!: Session;

    const llm1 = makeLLM(() => [
      { type: "tool-call", id: "call-1", name: "read", args: { path: "file.txt" } },
      { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
    ]);
    const llm2 = makeLLM((request) => {
      secondRequest = request;
      return [
        { type: "text-delta", text: "from llm2" },
        { type: "finish", reason: "end-turn", tokens: { input: 2, output: 2 } },
      ];
    });

    session = await createSession({
      llm: { llm: llm1, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      afterToolCall: async ({ toolName }) => {
        if (toolName === "read") {
          session.setTransformContext(async (messages) => [
            ...messages,
            {
              id: "transform-message",
              role: "assistant",
              parts: [{ type: "text", text: "from transform" }],
              agent: "coder",
              model: { provider: "test", model: "mock-1" },
              finishReason: "end-turn",
            },
          ]);
          session.setBeforePrompt(async ({ systemPrompt }) => ({
            systemPrompt: `${systemPrompt}\npatched prompt`,
            injectedMessages: [
              {
                id: "before-prompt-message",
                role: "assistant",
                parts: [{ type: "text", text: "from before prompt" }],
                agent: "coder",
                model: { provider: "test", model: "mock-2" },
                finishReason: "end-turn",
              },
            ],
          }));
          await session.setLLM({ llm: llm2, model: TEST_MODEL_2 });
        }
        return undefined;
      },
    });

    const result = await session.prompt("Read first, then continue.");

    expect(result.parts).toEqual([{ type: "text", text: "from llm2" }]);
    expect(result.model).toEqual({ provider: "test", model: "mock-2" });
    expect(session.model).toBe(TEST_MODEL_2);
    expect(secondRequest?.system).toContain("patched prompt");
    expect(textParts(secondRequest!)).toEqual(
      expect.arrayContaining([
        "Read first, then continue.",
        "from transform",
        "from before prompt",
      ]),
    );
  });

  test("emits session boundary events in order", async () => {
    const env = createMockEnvironment();
    const events: AgentEvent[] = [];
    const session = await createSession({
      llm: {
        llm: makeLLM(() => [
          { type: "text-delta", text: "hello" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ]),
        model: TEST_MODEL,
      },
      tools: createCoderTools(env, { workdir: "/project" }),
      onEvent(event) {
        events.push(event);
      },
    });

    await session.prompt("Hi");

    expect(events.map((event) => event.type)).toEqual([
      "message.created",
      "turn.start",
      "text.delta",
      "step.finish",
      "message.created",
      "done",
      "turn.end",
    ]);

    const turnStart = events.find((e) => e.type === "turn.start");
    expect(turnStart).toEqual({
      type: "turn.start",
      sessionId: session.id,
      messageId: expect.any(String),
    });

    const turnEnd = events.find((e) => e.type === "turn.end");
    expect(turnEnd).toEqual({
      type: "turn.end",
      sessionId: session.id,
      status: "completed",
    });
  });

  test("turn.end emits failed status on error", async () => {
    const env = createMockEnvironment();
    const events: AgentEvent[] = [];
    const session = await createSession({
      llm: { llm: makeLLM(() => [{ type: "error", error: new Error("boom") }]), model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      onEvent(event) {
        events.push(event);
      },
    });

    await session.prompt("Hi");

    const turnEnd = events.find((e) => e.type === "turn.end");
    expect(turnEnd).toEqual({
      type: "turn.end",
      sessionId: session.id,
      status: "failed",
    });
  });

  test("persists new sessions and messages through storage", async () => {
    const driver = new MemoryStorage();
    const storage = new SessionPersistenceAdapter(driver);
    const session = await createSession({
      sessionId: "session-1",
      llm: {
        llm: makeLLM((request) => [
          { type: "text-delta", text: `reply:${lastUserText(request)}` },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ]),
        model: TEST_MODEL,
      },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });

    await session.prompt("hello");

    const stored = await storage.loadSession("session-1");
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe("session-1");
    expect(await storage.loadVisibleMessages("session-1")).toEqual(session.messages());
  });

  test("persists host metadata at creation and reads it back", async () => {
    const driver = new MemoryStorage();
    const storage = new SessionPersistenceAdapter(driver);
    await createSession({
      sessionId: "session-1",
      llm: {
        llm: makeLLM(() => [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ]),
        model: TEST_MODEL,
      },
      metadata: { agentId: "explorer", tenant: "acme" },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });

    const stored = await storage.loadSession("session-1");
    expect(stored).not.toBeNull();
    expect(stored!.metadata).toEqual({ agentId: "explorer", tenant: "acme" });
  });

  test("readSession returns metadata and history for reattachment", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM((request) => [
      { type: "text-delta", text: `reply:${lastUserText(request)}` },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const first = await createSession({
      sessionId: "session-1",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
      metadata: { agentId: "coder" },
    });
    await first.prompt("hello");

    const loaded = await readSession(driver, "session-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata).toEqual({ agentId: "coder" });
    expect(loaded!.messages).toEqual(first.messages());

    const resumed = await createSession({
      sessionId: "session-1",
      attach: true,
      seedMessages: loaded!.messages,
      llm: { llm, model: TEST_MODEL_2 },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });

    expect(resumed.messages()).toEqual(first.messages());
    expect(resumed.model).toEqual(TEST_MODEL_2);
  });

  test("persists compacted visible history across resume and branch", async () => {
    const driver = new MemoryStorage();
    const storage = new SessionPersistenceAdapter(driver);
    const compaction: CompactionStrategy = async (messages) => {
      const latestUser = messages.findLast((message) => message.role === "user")!;
      return [compactedSummary("[S]\nstored"), latestUser];
    };
    let promptCalls = 0;
    const llm = makeLLM((request) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        return [
          { type: "text-delta", text: "first reply" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ];
      }
      expect(textParts(request)).toEqual(["[S]\nstored", "latest question"]);
      return [
        { type: "text-delta", text: "after compaction" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      sessionId: "session-1",
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
      compaction: { strategy: compaction },
    });

    await session.prompt("12345678901234567890");
    await session.prompt("latest question");

    expect(session.messages().map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect((await storage.loadVisibleMessages("session-1")).map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);

    const loaded = await readSession(driver, "session-1");
    const resumed = await createSession({
      sessionId: "session-1",
      attach: true,
      seedMessages: loaded!.messages,
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      storage: driver,
      compaction: { strategy: compaction },
    });

    expect(resumed.messages()).toEqual(session.messages());

    const branch = await session.branchFrom(session.messages()[1]!.id, { sessionId: "branch-1" });
    expect(branch.messages()).toEqual(session.messages().slice(0, 2));
    expect(await storage.loadVisibleMessages("branch-1")).toEqual(branch.messages());
  });

  test("child branches keep their persisted compacted prefix even after the parent compacts again", async () => {
    const driver = new MemoryStorage();
    const storage = new SessionPersistenceAdapter(driver);
    const compaction: CompactionStrategy = async (messages) => {
      const latestUser = messages.findLast((message) => message.role === "user")!;
      return [compactedSummary("[S]\nbranch"), latestUser];
    };
    let promptCalls = 0;
    const llm = makeLLM(() => {
      promptCalls += 1;
      return [
        { type: "text-delta", text: `reply-${promptCalls}` },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const parent = await createSession({
      sessionId: "parent",
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
      compaction: { strategy: compaction },
    });

    await parent.prompt("12345678901234567890");
    await parent.prompt("branch target");

    const branch = await parent.branchFrom(parent.messages()[1]!.id, { sessionId: "child" });
    expect(await storage.loadVisibleMessages("child")).toEqual(branch.messages());

    await parent.prompt("again now");

    const loadedChild = await readSession(driver, "child");
    const resumedChild = await createSession({
      sessionId: "child",
      attach: true,
      seedMessages: loadedChild!.messages,
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      storage: driver,
      compaction: { strategy: compaction },
    });

    expect(resumedChild.messages()).toEqual(await storage.loadVisibleMessages("child"));
    expect(resumedChild.messages()).toEqual(branch.messages());
  });

  test("surfaces storage failures during create, prompt, and model updates", async () => {
    class FailingDriver extends MemoryStorage {
      failInsertSession = false;
      failInsertTurn = false;
      failUpdateSession = false;

      override insertSession(session: StorageSession): void {
        if (this.failInsertSession) throw new Error("create failed");
        super.insertSession(session);
      }

      override insertTurn(...args: Parameters<MemoryStorage["insertTurn"]>): void {
        if (this.failInsertTurn) throw new Error("turn insert failed");
        super.insertTurn(...args);
      }

      override updateSession(...args: Parameters<MemoryStorage["updateSession"]>): void {
        if (this.failUpdateSession) throw new Error("update failed");
        super.updateSession(...args);
      }
    }

    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const createDriver = new FailingDriver();
    createDriver.failInsertSession = true;
    await expect(
      createSession({
        sessionId: "session-1",
        llm: { llm, model: TEST_MODEL },
        tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
        storage: createDriver,
      }),
    ).rejects.toThrow("create failed");

    const turnDriver = new FailingDriver();
    const turnSession = await createSession({
      sessionId: "session-2",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: turnDriver,
    });
    turnDriver.failInsertTurn = true;
    await expect(turnSession.prompt("hello")).rejects.toThrow("turn insert failed");

    const updateDriver = new FailingDriver();
    const updateSession2 = await createSession({
      sessionId: "session-3",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: updateDriver,
    });
    updateDriver.failUpdateSession = true;
    await expect(updateSession2.prompt("hello")).rejects.toThrow("update failed");
  });

  test("setLLM swaps the model for subsequent prompts", async () => {
    const session = await createSession({
      sessionId: "session-1",
      llm: {
        llm: makeLLM(() => [
          { type: "text-delta", text: "from llm1" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ]),
        model: TEST_MODEL,
      },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
    });

    await session.setLLM({
      llm: makeLLM(() => [
        { type: "text-delta", text: "from llm2" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ]),
      model: TEST_MODEL_2,
    });

    const result = await session.prompt("hello");
    expect(result.parts).toEqual([{ type: "text", text: "from llm2" }]);
    expect(result.model).toEqual({ provider: "test", model: "mock-2" });
    expect(session.model).toEqual(TEST_MODEL_2);
  });

  test("branches from a chosen message and keeps parent and child independent", async () => {
    const driver = new MemoryStorage();
    const storage = new SessionPersistenceAdapter(driver);
    const llm = makeLLM((request) => [
      { type: "text-delta", text: `reply:${lastUserText(request)}` },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const parent = await createSession({
      sessionId: "parent",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });
    await parent.prompt("one");
    await parent.prompt("two");

    const branchPoint = parent.messages()[1]?.id;
    expect(branchPoint).toBeDefined();
    const child = await parent.branchFrom(branchPoint!, { sessionId: "child" });

    expect(child.id).toBe("child");
    expect(child.messages()).toEqual(parent.messages().slice(0, 2));
    const childStored = await storage.loadSession("child");
    expect(childStored).not.toBeNull();
    expect(childStored!.parentSessionId).toBe("parent");
    expect(childStored!.branchedFromMessageId).toBe(branchPoint);

    await child.prompt("branch");
    await parent.prompt("three");

    expect(child.messages().map((message) => message.id)).toEqual([
      parent.messages()[0]!.id,
      parent.messages()[1]!.id,
      child.messages()[2]!.id,
      child.messages()[3]!.id,
    ]);
    expect(parent.messages()).toHaveLength(6);
    expect(child.messages()).toHaveLength(4);
    expect(await storage.loadVisibleMessages("child")).toEqual(child.messages());
  });

  test("branching preserves built-in tool overrides from the parent session", async () => {
    const driver = new MemoryStorage();
    const readOverride = makeReadOverrideTool("override output");
    const llm = makeLLM((request) => {
      const hasToolResult = request.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result"),
      );
      if (lastUserText(request) === "seed") {
        return [
          { type: "text-delta", text: "seeded" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ];
      }
      if (!hasToolResult) {
        return [
          { type: "tool-call", id: "call-1", name: "read", args: { path: "file.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const parent = await createSession({
      sessionId: "parent",
      llm: { llm, model: TEST_MODEL },
      tools: [
        ...createCoderTools(createMockEnvironment({ "/project/file.txt": "real file" }), {
          workdir: "/project",
        }),
        readOverride,
      ],
      storage: driver,
    });
    await parent.prompt("seed");

    const child = await parent.branchFrom(parent.messages()[0]!.id, { sessionId: "child" });
    await child.prompt("use read");

    const assistant = child.messages()[2];
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role === "assistant") {
      const toolPart = assistant.parts[0] as Extract<
        (typeof assistant.parts)[number],
        { type: "tool" }
      >;
      expect(toolPart.state).toEqual({
        status: "completed",
        output: "override output",
        duration: expect.any(Number),
      });
    }
  });

  test("rejects invalid branch targets", async () => {
    const session = await createSession({
      llm: {
        llm: makeLLM(() => [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ]),
        model: TEST_MODEL,
      },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
    });
    await session.prompt("hello");

    await expect(session.branchFrom("missing")).rejects.toThrow("Unknown branch point");
  });

  test("enforces maxSteps and stops the loop with a MAX_STEPS error", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    let llmCalls = 0;
    const llm = makeLLM(() => {
      llmCalls++;
      return [
        { type: "tool-call", id: `call-${llmCalls}`, name: "read", args: { path: "file.txt" } },
        { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
      ];
    });

    const events: AgentEvent[] = [];
    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      maxSteps: 3,
      onEvent(event) {
        events.push(event);
      },
    });

    const result = await session.prompt("Loop forever.");

    expect(llmCalls).toBe(3);
    expect(result.error?.code).toBe("MAX_STEPS");
    expect(result.error?.message).toBe("Step budget exhausted.");
    expect(result.finishReason).toBe("tool-calls");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("does not enforce maxSteps when undefined (unbounded)", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    let llmCalls = 0;
    const llm = makeLLM(() => {
      llmCalls++;
      if (llmCalls < 10) {
        return [
          { type: "tool-call", id: `call-${llmCalls}`, name: "read", args: { path: "file.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "finally done" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
    });

    const result = await session.prompt("Run for a while.");

    expect(llmCalls).toBe(10);
    expect(result.error).toBeUndefined();
    expect(result.finishReason).toBe("end-turn");
  });

  test("maxSteps=1 allows exactly one assistant turn", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    let llmCalls = 0;
    const llm = makeLLM(() => {
      llmCalls++;
      return [
        { type: "tool-call", id: `call-${llmCalls}`, name: "read", args: { path: "file.txt" } },
        { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      maxSteps: 1,
    });

    const result = await session.prompt("One shot.");

    expect(llmCalls).toBe(1);
    expect(result.error?.code).toBe("MAX_STEPS");
  });

  test("model that finishes naturally before maxSteps does not trigger MAX_STEPS", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    let llmCalls = 0;
    const llm = makeLLM(() => {
      llmCalls++;
      if (llmCalls === 1) {
        return [
          { type: "tool-call", id: "call-1", name: "read", args: { path: "file.txt" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "done early" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      maxSteps: 10,
    });

    const result = await session.prompt("Finish early.");

    expect(llmCalls).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.finishReason).toBe("end-turn");
  });

  test("a host-authored subagent tool runs a child session with its own maxSteps", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    let childLLMCalls = 0;
    const llm = makeLLM((request) => {
      const toolNames = request.tools.map((tool) => tool.name);
      const hasToolResult = request.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result"),
      );

      if (toolNames.includes("task")) {
        if (!hasToolResult) {
          return [
            {
              type: "tool-call",
              id: "task-1",
              name: "task",
              args: { prompt: "Read everything." },
            },
            { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
          ];
        }
        return [
          { type: "text-delta", text: "parent done" },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ];
      }

      childLLMCalls++;
      return [
        {
          type: "tool-call",
          id: `child-${childLLMCalls}`,
          name: "read",
          args: { path: "file.txt" },
        },
        { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
      ];
    });

    // Sub-agents are now a host tool that calls createSession itself, owning the
    // child's config (here a tighter maxSteps than the parent).
    const taskTool: ToolDef<{ prompt: string }> = {
      id: "task",
      description: "Delegate to a child agent.",
      parameters: z.object({ prompt: z.string() }),
      async execute({ prompt }) {
        const child = await createSession({
          llm: { llm, model: TEST_MODEL },
          tools: createCoderTools(env, { workdir: "/project" }),
          maxSteps: 2,
        });
        const reply = await child.prompt(prompt);
        return { output: reply.error ? `child stopped: ${reply.error.code}` : "child done" };
      },
    };

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: [taskTool],
      maxSteps: 50,
    });

    const result = await session.prompt("Delegate to subagent.");

    expect(childLLMCalls).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.finishReason).toBe("end-turn");

    const taskTurn = session.messages()[1];
    expect(taskTurn?.role).toBe("assistant");
    if (taskTurn?.role === "assistant") {
      const toolPart = taskTurn.parts.find((p) => p.type === "tool");
      expect(toolPart?.type).toBe("tool");
    }
  });

  test("beforeBranch can cancel branching", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeBranch: async () => ({ cancel: true, reason: "Not allowed" }),
    });

    await session.prompt("hello");
    const msgs = session.messages();
    const userMsg = msgs.find((m) => m.role === "user")!;

    await expect(session.branchFrom(userMsg.id)).rejects.toThrow("Not allowed");
  });

  test("beforeBranch cancellation uses default message when no reason given", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeBranch: async () => ({ cancel: true }),
    });

    await session.prompt("hello");
    const userMsg = session.messages().find((m) => m.role === "user")!;
    await expect(session.branchFrom(userMsg.id)).rejects.toThrow("Branch cancelled.");
  });

  test("beforeBranch receives context and allows branching when returning undefined", async () => {
    const env = createMockEnvironment();
    const hookCalls: Array<{ sessionId: string; messageId: string; messageCount: number }> = [];
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeBranch: async (ctx) => {
        hookCalls.push({
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          messageCount: ctx.messages.length,
        });
        return undefined;
      },
    });

    await session.prompt("hello");
    const userMsg = session.messages().find((m) => m.role === "user")!;
    const child = await session.branchFrom(userMsg.id);

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.sessionId).toBe(session.id);
    expect(hookCalls[0]!.messageId).toBe(userMsg.id);
    expect(hookCalls[0]!.messageCount).toBe(2);
    expect(child.id).not.toBe(session.id);
  });

  test("setBeforeBranch replaces the hook at runtime", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeBranch: async () => ({ cancel: true }),
    });

    await session.prompt("hello");
    const userMsg = session.messages().find((m) => m.role === "user")!;
    await expect(session.branchFrom(userMsg.id)).rejects.toThrow("Branch cancelled.");

    session.setBeforeBranch(undefined);
    const child = await session.branchFrom(userMsg.id);
    expect(child.id).not.toBe(session.id);
  });

  test("beforeInput can transform string input", async () => {
    const env = createMockEnvironment();
    const seenMessages: LLMRequest[] = [];
    const llm = makeLLM((request) => {
      seenMessages.push(request);
      return [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async ({ input }) => ({
        input: `[prefix] ${input}`,
      }),
    });

    await session.prompt("hello");
    const msgs = session.messages();
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg?.parts).toEqual([{ type: "text", text: "[prefix] hello" }]);
  });

  test("beforeInput can transform UserPart[] input", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async () => ({
        input: [{ type: "text", text: "replaced" }],
      }),
    });

    await session.prompt("original");
    const msgs = session.messages();
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg?.parts).toEqual([{ type: "text", text: "replaced" }]);
  });

  test("beforeInput can reject input", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "should not reach" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async () => ({
        reject: true as const,
        reason: "Bad input",
      }),
    });

    await expect(session.prompt("hello")).rejects.toThrow("Bad input");
    expect(session.messages()).toHaveLength(0);
  });

  test("beforeInput rejection uses default message when no reason given", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "should not reach" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async () => ({ reject: true as const }),
    });

    await expect(session.prompt("hello")).rejects.toThrow("Input rejected.");
  });

  test("beforeInput returning undefined leaves input unchanged", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async () => undefined,
    });

    await session.prompt("original text");
    const msgs = session.messages();
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg?.parts).toEqual([{ type: "text", text: "original text" }]);
  });

  test("beforeInput receives sessionId", async () => {
    const env = createMockEnvironment();
    const hookCalls: Array<{ sessionId: string }> = [];
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async (ctx) => {
        hookCalls.push({ sessionId: ctx.sessionId });
        return undefined;
      },
    });

    await session.prompt("hello");
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.sessionId).toBe(session.id);
  });

  test("setBeforeInput replaces the hook at runtime", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async ({ input }) => ({ input: `v1: ${input}` }),
    });

    await session.prompt("hello");
    const msg1 = session.messages().find((m) => m.role === "user");
    expect(msg1?.parts).toEqual([{ type: "text", text: "v1: hello" }]);

    session.setBeforeInput(async ({ input }) => ({ input: `v2: ${input}` }));

    await session.prompt("world");
    const msgs = session.messages().filter((m) => m.role === "user");
    expect(msgs[1]?.parts).toEqual([{ type: "text", text: "v2: world" }]);
  });

  test("setBeforeInput(undefined) removes the hook", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeInput: async ({ input }) => ({ input: `modified: ${input}` }),
    });

    await session.prompt("first");
    session.setBeforeInput(undefined);
    await session.prompt("second");

    const userMsgs = session.messages().filter((m) => m.role === "user");
    expect(userMsgs[0]?.parts).toEqual([{ type: "text", text: "modified: first" }]);
    expect(userMsgs[1]?.parts).toEqual([{ type: "text", text: "second" }]);
  });

  test("beforeCompaction can cancel compaction", async () => {
    const env = createMockEnvironment();
    let strategyCalled = false;
    const compactionStrategy: CompactionStrategy = async (messages) => {
      strategyCalled = true;
      const latestUser = messages.findLast((m) => m.role === "user")!;
      return [compactedSummary("[S]\ncompacted"), latestUser];
    };

    let promptCalls = 0;
    const llm = makeLLM(() => {
      promptCalls++;
      if (promptCalls <= 3) {
        return [
          { type: "text-delta", text: `fill ${promptCalls}` },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ];
      }
      return [
        { type: "text-delta", text: "final" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: { strategy: compactionStrategy },
      beforeCompaction: async () => ({ cancel: true }),
    });

    for (let i = 0; i < 3; i++) {
      await session.prompt(`fill ${i}`);
    }

    const result = await session.prompt("latest question");
    expect(strategyCalled).toBe(false);
    expect(result.parts).toEqual([{ type: "text", text: "final" }]);
  });

  test("beforeCompaction can supply custom messages", async () => {
    const env = createMockEnvironment();
    let strategyCalled = false;
    const compactionStrategy: CompactionStrategy = async (messages) => {
      strategyCalled = true;
      const latestUser = messages.findLast((m) => m.role === "user")!;
      return [compactedSummary("[S]\ndefault"), latestUser];
    };

    let promptCalls = 0;
    const llm = makeLLM((request) => {
      promptCalls++;
      if (promptCalls <= 3) {
        return [
          { type: "text-delta", text: `fill ${promptCalls}` },
          { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
        ];
      }
      expect(textParts(request)).toEqual(["[S]\ncustom", "latest question"]);
      return [
        { type: "text-delta", text: "after custom compaction" },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: { strategy: compactionStrategy },
      beforeCompaction: async ({ messages }) => {
        const latestUser = messages.findLast((m) => m.role === "user")!;
        return { messages: [compactedSummary("[S]\ncustom"), latestUser] };
      },
    });

    for (let i = 0; i < 3; i++) {
      await session.prompt(`fill ${i}`);
    }

    const result = await session.prompt("latest question");
    expect(strategyCalled).toBe(false);
    expect(result.parts).toEqual([{ type: "text", text: "after custom compaction" }]);
  });

  test("beforeCompaction receives reason and context", async () => {
    const env = createMockEnvironment();
    const hookCalls: Array<{ sessionId: string; reason: string; estimatedTokens: number }> = [];
    const compactionStrategy: CompactionStrategy = async (messages) => {
      const latestUser = messages.findLast((m) => m.role === "user")!;
      return [compactedSummary("[S]\ns"), latestUser];
    };

    let promptCalls = 0;
    const llm = makeLLM(() => {
      promptCalls++;
      return [
        { type: "text-delta", text: `response ${promptCalls}` },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: { strategy: compactionStrategy },
      beforeCompaction: async (ctx) => {
        hookCalls.push({
          sessionId: ctx.sessionId,
          reason: ctx.reason,
          estimatedTokens: ctx.estimatedTokens,
        });
        return undefined;
      },
    });

    for (let i = 0; i < 3; i++) {
      await session.prompt(`fill ${i}`);
    }

    await session.prompt("latest question");
    expect(hookCalls.length).toBeGreaterThan(0);
    expect(hookCalls[0]!.sessionId).toBe(session.id);
    expect(hookCalls[0]!.reason).toBe("proactive");
    expect(hookCalls[0]!.estimatedTokens).toBeGreaterThan(0);
  });

  test("setBeforeCompaction replaces the hook at runtime", async () => {
    const env = createMockEnvironment();
    const compactionStrategy: CompactionStrategy = async (messages) => {
      const latestUser = messages.findLast((m) => m.role === "user")!;
      return [compactedSummary("[S]\ns"), latestUser];
    };

    let strategyCalled = false;
    let promptCalls = 0;
    const llm = makeLLM(() => {
      promptCalls++;
      return [
        { type: "text-delta", text: `response ${promptCalls}` },
        { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: SMALL_CONTEXT_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: { strategy: compactionStrategy },
      beforeCompaction: async () => ({ cancel: true }),
    });

    for (let i = 0; i < 3; i++) {
      await session.prompt(`fill ${i}`);
    }

    session.setBeforeCompaction(async () => {
      strategyCalled = true;
      return undefined;
    });

    await session.prompt("trigger compaction");
    expect(strategyCalled).toBe(true);
  });

  test("compact() manually compacts outside of a turn", async () => {
    const env = createMockEnvironment();
    const events: AgentEvent[] = [];
    const reasons: string[] = [];
    const compactionStrategy: CompactionStrategy = async (messages, ctx) => {
      reasons.push(ctx.reason);
      const latestUser = messages.findLast((m) => m.role === "user")!;
      return [compactedSummary("[S]\nmanual"), latestUser];
    };

    const llm = makeLLM(() => [
      { type: "text-delta", text: "a]lengthy response that pads the history" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: { strategy: compactionStrategy },
      onEvent(event) {
        events.push(event);
      },
    });

    await session.prompt("first question with some extra text to bulk up the history");
    await session.prompt("second question with even more text to make it larger");
    await session.prompt("third question to ensure the history is big enough");

    const messagesBefore = session.messages().length;
    const didCompact = await session.compact();

    expect(didCompact).toBe(true);
    expect(reasons).toEqual(["manual"]);
    expect(session.messages().length).toBeLessThan(messagesBefore);
    expect(session.messages()[0]!.parts).toEqual([{ type: "text", text: "[S]\nmanual" }]);
    expect(events.some((e) => e.type === "compaction")).toBe(true);
  });

  test("compact() returns false when compaction is disabled", async () => {
    const env = createMockEnvironment();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      compaction: false,
    });

    await session.prompt("hello");
    const didCompact = await session.compact();
    expect(didCompact).toBe(false);
  });

  test("beforeLLMCall can override temperature and maxOutputTokens", async () => {
    const env = createMockEnvironment();
    const seenRequests: LLMRequest[] = [];
    const llm = makeLLM((request) => {
      seenRequests.push(request);
      return [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeLLMCall: async () => ({
        temperature: 0.2,
        maxOutputTokens: 500,
      }),
    });

    await session.prompt("hello");
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]!.temperature).toBe(0.2);
    expect(seenRequests[0]!.maxOutputTokens).toBe(500);
  });

  test("beforeLLMCall can inject providerOptions", async () => {
    const env = createMockEnvironment();
    const seenRequests: LLMRequest[] = [];
    const llm = makeLLM((request) => {
      seenRequests.push(request);
      return [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeLLMCall: async () => ({
        providerOptions: { headers: { "X-Trace-Id": "abc-123" } },
      }),
    });

    await session.prompt("hello");
    expect(seenRequests[0]!.providerOptions).toEqual({
      headers: { "X-Trace-Id": "abc-123" },
    });
  });

  test("beforeLLMCall receives session context", async () => {
    const env = createMockEnvironment();
    const hookCalls: Array<{ sessionId: string; system: string }> = [];
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
    ]);

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      systemPrompt: "You are a coder.",
      beforeLLMCall: async (ctx) => {
        hookCalls.push({
          sessionId: ctx.sessionId,
          system: ctx.system,
        });
        return undefined;
      },
    });

    await session.prompt("hello");
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.sessionId).toBe(session.id);
    expect(hookCalls[0]!.system).toContain("You are");
  });

  test("beforeLLMCall returning undefined leaves params unchanged", async () => {
    const env = createMockEnvironment();
    const seenRequests: LLMRequest[] = [];
    const llm = makeLLM((request) => {
      seenRequests.push(request);
      return [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeLLMCall: async () => undefined,
    });

    await session.prompt("hello");
    expect(seenRequests[0]!.temperature).toBeUndefined();
    expect(seenRequests[0]!.maxOutputTokens).toBeUndefined();
    expect(seenRequests[0]!.providerOptions).toBeUndefined();
  });

  test("setBeforeLLMCall replaces the hook at runtime", async () => {
    const env = createMockEnvironment();
    const seenRequests: LLMRequest[] = [];
    const llm = makeLLM((request) => {
      seenRequests.push(request);
      return [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeLLMCall: async () => ({ temperature: 0.1 }),
    });

    await session.prompt("first");
    expect(seenRequests[0]!.temperature).toBe(0.1);

    session.setBeforeLLMCall(async () => ({ temperature: 0.9 }));

    await session.prompt("second");
    expect(seenRequests[1]!.temperature).toBe(0.9);
  });

  test("setBeforeLLMCall(undefined) removes the hook", async () => {
    const env = createMockEnvironment();
    const seenRequests: LLMRequest[] = [];
    const llm = makeLLM((request) => {
      seenRequests.push(request);
      return [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "end-turn", tokens: { input: 10, output: 5 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      beforeLLMCall: async () => ({ temperature: 0.5 }),
    });

    await session.prompt("first");
    expect(seenRequests[0]!.temperature).toBe(0.5);

    session.setBeforeLLMCall(undefined);

    await session.prompt("second");
    expect(seenRequests[1]!.temperature).toBeUndefined();
  });

  test("step counter resets between prompt calls", async () => {
    const env = createMockEnvironment({ "/project/file.txt": "hello" });
    let llmCalls = 0;
    const llm = makeLLM(() => {
      llmCalls++;
      return [
        { type: "tool-call", id: `call-${llmCalls}`, name: "read", args: { path: "file.txt" } },
        { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
      ];
    });

    const session = await createSession({
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(env, { workdir: "/project" }),
      maxSteps: 2,
    });

    const r1 = await session.prompt("First prompt.");
    expect(r1.error?.code).toBe("MAX_STEPS");
    const callsAfterFirst = llmCalls;

    const r2 = await session.prompt("Second prompt.");
    expect(r2.error?.code).toBe("MAX_STEPS");
    expect(llmCalls - callsAfterFirst).toBe(2);
  });

  test("createSession throws when sessionId already exists in storage", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    await createSession({
      sessionId: "existing-session",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });

    await expect(
      createSession({
        sessionId: "existing-session",
        llm: { llm, model: TEST_MODEL },
        tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
        storage: driver,
      }),
    ).rejects.toThrow("Session already exists: existing-session");
  });

  test("readSession returns null when session does not exist", async () => {
    const driver = new MemoryStorage();

    expect(await readSession(driver, "nonexistent")).toBeNull();
  });

  test("attach fails when the session does not exist", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    await expect(
      createSession({
        sessionId: "nonexistent",
        attach: true,
        llm: { llm, model: TEST_MODEL },
        storage: driver,
      }),
    ).rejects.toThrow("Session not found: nonexistent");
  });

  test("attach reuses the existing session and keeps appending turns", async () => {
    const driver = new MemoryStorage();
    const storage = new SessionPersistenceAdapter(driver);
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const first = await createSession({
      sessionId: "session-1",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/original" }),
      storage: driver,
    });
    await first.prompt("hello");

    const loaded = await readSession(driver, "session-1");
    const resumed = await createSession({
      sessionId: "session-1",
      attach: true,
      seedMessages: loaded!.messages,
      llm: { llm, model: TEST_MODEL_2 },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/original" }),
      storage: driver,
    });

    expect(resumed.id).toBe("session-1");
    expect(resumed.messages()).toEqual(first.messages());
    await resumed.prompt("again");
    expect((await storage.loadVisibleMessages("session-1")).length).toBe(4);
  });

  test("branchFrom exposes parentId and branchedFromMessageId on the child session", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM((request) => [
      { type: "text-delta", text: `reply:${lastUserText(request)}` },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const parent = await createSession({
      sessionId: "parent",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });
    await parent.prompt("hello");

    expect(parent.parentId).toBeUndefined();
    expect(parent.branchedFromMessageId).toBeUndefined();

    const branchPoint = parent.messages()[0]!.id;
    const child = await parent.branchFrom(branchPoint, { sessionId: "child" });

    expect(child.parentId).toBe("parent");
    expect(child.branchedFromMessageId).toBe(branchPoint);
  });

  test("attach preserves parentId and branchedFromMessageId", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM((request) => [
      { type: "text-delta", text: `reply:${lastUserText(request)}` },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const parent = await createSession({
      sessionId: "parent",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });
    await parent.prompt("hello");

    const branchPoint = parent.messages()[0]!.id;
    await parent.branchFrom(branchPoint, { sessionId: "child" });

    const loaded = await readSession(driver, "child");
    expect(loaded!.parentSessionId).toBe("parent");
    expect(loaded!.branchedFromMessageId).toBe(branchPoint);

    const resumed = await createSession({
      sessionId: "child",
      attach: true,
      seedMessages: loaded!.messages,
      llm: { llm, model: TEST_MODEL },
      storage: driver,
    });

    expect(resumed.parentId).toBe("parent");
    expect(resumed.branchedFromMessageId).toBe(branchPoint);
  });

  test("listSessions returns all sessions ordered by creation time", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    await createSession({
      sessionId: "session-a",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });
    await createSession({
      sessionId: "session-b",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });

    const sessions = await listSessions(driver);
    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining(["session-a", "session-b"]));
    expect(sessions).toHaveLength(2);
  });

  test("listBranches returns child sessions of a parent", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM((request) => [
      { type: "text-delta", text: `reply:${lastUserText(request)}` },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    const parent = await createSession({
      sessionId: "parent",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
    });
    await parent.prompt("hello");

    const msg = parent.messages()[0]!.id;
    await parent.branchFrom(msg, { sessionId: "branch-1" });
    await parent.branchFrom(msg, { sessionId: "branch-2" });

    const branches = await listBranches(driver, "parent");
    expect(branches.map((b) => b.id)).toEqual(expect.arrayContaining(["branch-1", "branch-2"]));
    expect(branches).toHaveLength(2);
    expect(branches[0]!.parentSessionId).toBe("parent");
    expect(branches[0]!.branchedFromMessageId).toBe(msg);

    const noBranches = await listBranches(driver, "branch-1");
    expect(noBranches).toHaveLength(0);
  });

  test("getSessionInfo returns session metadata or null", async () => {
    const driver = new MemoryStorage();
    const llm = makeLLM(() => [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } },
    ]);

    await createSession({
      sessionId: "session-1",
      llm: { llm, model: TEST_MODEL },
      tools: createCoderTools(createMockEnvironment(), { workdir: "/project" }),
      storage: driver,
      metadata: { agentId: "coder" },
    });

    const info = await getSessionInfo(driver, "session-1");
    expect(info).not.toBeNull();
    expect(info!.id).toBe("session-1");
    expect(info!.metadata).toEqual({ agentId: "coder" });
    expect(info!.parentSessionId).toBeUndefined();

    const missing = await getSessionInfo(driver, "nonexistent");
    expect(missing).toBeNull();
  });
});
