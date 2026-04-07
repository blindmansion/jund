import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createToolContext } from "../../test-helpers.ts";
import { executeToolWithHooks } from "../../../src/tool/hooks.ts";
import type { ToolDef } from "../../../src/tool/types.ts";

function makeTool(execute: ToolDef["execute"]): ToolDef<{ value: string }> {
  return {
    id: "demo",
    description: "demo tool",
    parameters: z.object({
      value: z.string(),
    }),
    execute,
  };
}

describe("executeToolWithHooks", () => {
  test("passes tool metadata into beforeToolCall", async () => {
    const ctx = createToolContext();
    let seenToolCallId = "";
    let seenSignal: AbortSignal | undefined;

    const result = await executeToolWithHooks({
      tool: makeTool(async () => ({ output: "ok" })),
      args: { value: "hello" },
      ctx,
      toolCallId: "call-1",
      beforeToolCall: async ({ toolName, toolCallId, args, signal }) => {
        expect(toolName).toBe("demo");
        expect(args).toEqual({ value: "hello" });
        seenToolCallId = toolCallId;
        seenSignal = signal;
        return undefined;
      },
    });

    expect(result).toEqual({ result: { output: "ok" }, isError: false });
    expect(seenToolCallId).toBe("call-1");
    expect(seenSignal).toBe(ctx.abort);
  });

  test("blocks execution when beforeToolCall says so", async () => {
    let executed = false;

    const result = await executeToolWithHooks({
      tool: makeTool(async () => {
        executed = true;
        return { output: "ok" };
      }),
      args: { value: "hello" },
      ctx: createToolContext(),
      toolCallId: "call-2",
      beforeToolCall: async () => ({ block: true, reason: "nope" }),
    });

    expect(executed).toBe(false);
    expect(result).toEqual({ result: { output: "nope" }, isError: true });
  });

  test("converts thrown errors into error results", async () => {
    const result = await executeToolWithHooks({
      tool: makeTool(async () => {
        throw new Error("boom");
      }),
      args: { value: "hello" },
      ctx: createToolContext(),
      toolCallId: "call-3",
    });

    expect(result).toEqual({ result: { output: "boom" }, isError: true });
  });

  test("lets afterToolCall transform output", async () => {
    const result = await executeToolWithHooks({
      tool: makeTool(async () => ({ output: "raw", title: "demo" })),
      args: { value: "hello" },
      ctx: createToolContext(),
      toolCallId: "call-4",
      afterToolCall: async ({ result, isError }) => {
        expect(result.title).toBe("demo");
        expect(isError).toBe(false);
        return { output: result.output.toUpperCase() };
      },
    });

    expect(result).toEqual({ result: { output: "RAW", title: "demo" }, isError: false });
  });

  test("lets afterToolCall recover from an error", async () => {
    const result = await executeToolWithHooks({
      tool: makeTool(async () => {
        throw new Error("blocked by sandbox");
      }),
      args: { value: "hello" },
      ctx: createToolContext(),
      toolCallId: "call-5",
      afterToolCall: async ({ isError }) => ({
        output: "handled",
        isError: !isError ? true : false,
      }),
    });

    expect(result).toEqual({ result: { output: "handled" }, isError: false });
  });
});
