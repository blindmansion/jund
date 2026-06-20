import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { processTurn } from "../../src/processor.ts";
import { FileMutationQueue } from "../../src/tool/queue.ts";
import type { AgentEvent } from "../../src/events.ts";
import type { LLMProvider, LLMRequest, LLMStreamEvent } from "../../src/llm.ts";
import type { ToolDef } from "../../src/tool/types.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (check()) return;
    await Bun.sleep(1);
  }
}

function makeLLM(
  events: LLMStreamEvent[] | ((request: LLMRequest) => AsyncIterable<LLMStreamEvent>),
): LLMProvider {
  return {
    stream(request: LLMRequest) {
      if (typeof events === "function") {
        return events(request);
      }
      return (async function* () {
        yield* events;
      })();
    },
  };
}

function baseOptions(
  overrides: Partial<Parameters<typeof processTurn>[0]> = {},
): Parameters<typeof processTurn>[0] {
  const emitted: AgentEvent[] = [];
  return {
    llm: makeLLM([{ type: "finish", reason: "end-turn", tokens: { input: 1, output: 1 } }]),
    system: "system",
    messages: [],
    tools: [],
    toolMap: new Map(),
    sessionId: "session-1",
    agent: "coder",
    model: { provider: "test", model: "mock-1" },
    abort: new AbortController().signal,
    emit(event) {
      emitted.push(event);
    },
    queue: new FileMutationQueue(),
    ...overrides,
  };
}

describe("processTurn", () => {
  test("accumulates reasoning and text deltas into assistant parts", async () => {
    const emitted: AgentEvent[] = [];
    const message = await processTurn({
      ...baseOptions({
        llm: makeLLM([
          { type: "reasoning-delta", text: "Plan " },
          { type: "reasoning-delta", text: "more" },
          { type: "text-delta", text: "Done" },
          { type: "finish", reason: "end-turn", tokens: { input: 10, output: 2 } },
        ]),
      }),
      emit(event) {
        emitted.push(event);
      },
    });

    expect(message.finishReason).toBe("end-turn");
    expect(message.tokens).toEqual({ input: 10, output: 2 });
    expect(message.parts).toEqual([
      { type: "reasoning", text: "Plan more" },
      { type: "text", text: "Done" },
    ]);
    expect(emitted.map((event) => event.type)).toEqual([
      "reasoning.delta",
      "reasoning.delta",
      "text.delta",
      "step.finish",
    ]);
  });

  test("applies prepareArgs before validation and execution", async () => {
    let seenArgs: unknown;
    const editTool: ToolDef = {
      id: "edit",
      description: "edit file",
      parameters: z.object({
        path: z.string(),
        edits: z.array(
          z.object({
            oldText: z.string(),
            newText: z.string(),
          }),
        ),
      }),
      prepareArgs(args) {
        const { path, oldText, newText } = args as Record<string, string>;
        return { path, edits: [{ oldText, newText }] };
      },
      async execute(args) {
        seenArgs = args;
        return { output: "patched" };
      },
    };

    const message = await processTurn(
      baseOptions({
        llm: makeLLM([
          {
            type: "tool-call",
            id: "call-1",
            name: "edit",
            args: { path: "a.ts", oldText: "a", newText: "b" },
          },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ]),
        tools: [{ name: "edit", description: "edit file", parameters: {} }],
        toolMap: new Map([["edit", editTool]]),
      }),
    );

    expect(seenArgs).toEqual({
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(message.parts[0]).toMatchObject({
      type: "tool",
      tool: "edit",
      state: { status: "completed", output: "patched" },
    });
  });

  test("returns an error result when tool args fail validation", async () => {
    const readTool: ToolDef = {
      id: "read",
      description: "read file",
      parameters: z.object({ path: z.string() }),
      async execute() {
        return { output: "should not run" };
      },
    };

    const message = await processTurn(
      baseOptions({
        llm: makeLLM([
          { type: "tool-call", id: "call-1", name: "read", args: { nope: true } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ]),
        tools: [{ name: "read", description: "read file", parameters: {} }],
        toolMap: new Map([["read", readTool]]),
      }),
    );

    expect(message.parts[0]).toMatchObject({
      type: "tool",
      tool: "read",
      state: {
        status: "error",
      },
    });
    const toolPart = message.parts[0] as Extract<(typeof message.parts)[number], { type: "tool" }>;
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toContain("Invalid arguments for read");
    }
  });

  test("runs tool calls in parallel by default", async () => {
    const firstGate = deferred<void>();
    const order: string[] = [];
    const tool: ToolDef = {
      id: "demo",
      description: "demo",
      parameters: z.object({ name: z.string() }),
      async execute(args) {
        order.push(`${args.name}:start`);
        if (args.name === "first") {
          await firstGate.promise;
        }
        order.push(`${args.name}:end`);
        return { output: args.name };
      },
    };

    const turnPromise = processTurn(
      baseOptions({
        llm: makeLLM([
          { type: "tool-call", id: "call-1", name: "demo", args: { name: "first" } },
          { type: "tool-call", id: "call-2", name: "demo", args: { name: "second" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ]),
        tools: [{ name: "demo", description: "demo", parameters: {} }],
        toolMap: new Map([["demo", tool]]),
      }),
    );

    await waitFor(() => order.length === 3);
    expect(order).toEqual(["first:start", "second:start", "second:end"]);

    firstGate.resolve();
    await turnPromise;
  });

  test("runs tool calls sequentially when configured", async () => {
    const firstGate = deferred<void>();
    const order: string[] = [];
    const tool: ToolDef = {
      id: "demo",
      description: "demo",
      parameters: z.object({ name: z.string() }),
      async execute(args) {
        order.push(`${args.name}:start`);
        if (args.name === "first") {
          await firstGate.promise;
        }
        order.push(`${args.name}:end`);
        return { output: args.name };
      },
    };

    const turnPromise = processTurn(
      baseOptions({
        llm: makeLLM([
          { type: "tool-call", id: "call-1", name: "demo", args: { name: "first" } },
          { type: "tool-call", id: "call-2", name: "demo", args: { name: "second" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ]),
        tools: [{ name: "demo", description: "demo", parameters: {} }],
        toolMap: new Map([["demo", tool]]),
        toolExecution: "sequential",
      }),
    );

    await waitFor(() => order.length === 1);
    expect(order).toEqual(["first:start"]);

    firstGate.resolve();
    await turnPromise;
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("serializes conflicting write operations through the file mutation queue", async () => {
    const firstGate = deferred<void>();
    const order: string[] = [];
    const writeTool: ToolDef<{ path: string }> = {
      id: "write",
      description: "write file",
      parameters: z.object({ path: z.string() }),
      mutationKey: (args) => args.path,
      async execute(args) {
        order.push(`${args.path}:start`);
        if (args.path === "a.ts") {
          await firstGate.promise;
        }
        order.push(`${args.path}:end`);
        return { output: args.path };
      },
    };

    const turnPromise = processTurn(
      baseOptions({
        llm: makeLLM([
          { type: "tool-call", id: "call-1", name: "write", args: { path: "a.ts" } },
          { type: "tool-call", id: "call-2", name: "write", args: { path: "a.ts" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ]),
        tools: [{ name: "write", description: "write file", parameters: {} }],
        toolMap: new Map([["write", writeTool]]),
      }),
    );

    await waitFor(() => order.length === 1);
    expect(order).toEqual(["a.ts:start"]);

    firstGate.resolve();
    await turnPromise;
    expect(order).toEqual(["a.ts:start", "a.ts:end", "a.ts:start", "a.ts:end"]);
  });

  test("emits tool lifecycle events before step.finish", async () => {
    const events: AgentEvent[] = [];
    const tool: ToolDef = {
      id: "bash",
      description: "run command",
      parameters: z.object({ command: z.string() }),
      async execute(_args, ctx) {
        ctx.onUpdate({ output: "chunk" });
        return { output: "final" };
      },
    };

    await processTurn({
      ...baseOptions({
        llm: makeLLM([
          { type: "tool-call", id: "call-1", name: "bash", args: { command: "echo hi" } },
          { type: "finish", reason: "tool-calls", tokens: { input: 1, output: 1 } },
        ]),
        tools: [{ name: "bash", description: "run command", parameters: {} }],
        toolMap: new Map([["bash", tool]]),
      }),
      emit(event) {
        events.push(event);
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool.start",
      "tool.output",
      "tool.end",
      "step.finish",
    ]);
  });

  test("retries a clean stream failure and succeeds on the next attempt", async () => {
    const events: AgentEvent[] = [];
    let attempts = 0;
    const llm: LLMProvider = {
      stream() {
        attempts += 1;
        return (async function* () {
          if (attempts === 1) {
            throw Object.assign(new Error("429 rate limit"), { status: 429 });
          }
          yield { type: "text-delta" as const, text: "Recovered" };
          yield { type: "finish" as const, reason: "end-turn", tokens: { input: 3, output: 1 } };
        })();
      },
    };

    const message = await processTurn({
      ...baseOptions({ llm, retry: { maxAttempts: 2, maxDelayMs: 0 } }),
      emit(event) {
        events.push(event);
      },
    });

    expect(attempts).toBe(2);
    expect(message.finishReason).toBe("end-turn");
    expect(message.error).toBeUndefined();
    expect(message.parts).toEqual([{ type: "text", text: "Recovered" }]);
    expect(events.map((event) => event.type)).toEqual(["retry", "text.delta", "step.finish"]);
    expect(events[0]).toMatchObject({
      type: "retry",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 0,
      error: "429 rate limit",
    });
  });

  test("does not retry non-retryable stream failures", async () => {
    let attempts = 0;
    const llm: LLMProvider = {
      stream() {
        attempts += 1;
        return {
          [Symbol.asyncIterator]() {
            throw new Error("bad request");
          },
        } as AsyncIterable<LLMStreamEvent>;
      },
    };

    const message = await processTurn(
      baseOptions({
        llm,
        retry: { maxAttempts: 3, maxDelayMs: 0 },
      }),
    );

    expect(attempts).toBe(1);
    expect(message.finishReason).toBe("error");
    expect(message.error?.retryable).toBe(false);
  });
});
