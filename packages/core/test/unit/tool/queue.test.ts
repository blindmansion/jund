import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createToolContext } from "../../test-helpers.ts";
import { executeToolWithQueue, FileMutationQueue } from "../../../src/tool/queue.ts";
import type { ToolDef } from "../../../src/tool/types.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeTool(
  id: string,
  execute: ToolDef<{ path: string }>["execute"],
  mutationKey?: (args: { path: string }) => string | undefined,
): ToolDef<{ path: string }> {
  return {
    id,
    description: `${id} tool`,
    parameters: z.object({
      path: z.string(),
    }),
    mutationKey,
    execute,
  };
}

describe("FileMutationQueue", () => {
  test("serializes mutations to the same path", async () => {
    const queue = new FileMutationQueue();
    const order: string[] = [];
    const firstGate = deferred<void>();

    const first = queue.run("/project/file.ts", async () => {
      order.push("first:start");
      await firstGate.promise;
      order.push("first:end");
      return "first";
    });

    const second = queue.run("/project/file.ts", async () => {
      order.push("second:start");
      order.push("second:end");
      return "second";
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    firstGate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("allows different paths to proceed concurrently", async () => {
    const queue = new FileMutationQueue();
    const order: string[] = [];

    await Promise.all([
      queue.run("/project/a.ts", async () => {
        order.push("a:start");
        await Promise.resolve();
        order.push("a:end");
      }),
      queue.run("/project/b.ts", async () => {
        order.push("b:start");
        await Promise.resolve();
        order.push("b:end");
      }),
    ]);

    expect(order.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
  });

  test("tools without a mutationKey run unserialized", async () => {
    const queue = new FileMutationQueue();
    const order: string[] = [];
    const firstGate = deferred<void>();
    const tool = makeTool("read", async (args) => {
      order.push(`start:${args.path}`);
      if (args.path === "a.ts") {
        await firstGate.promise;
      }
      order.push(`end:${args.path}`);
      return { output: args.path };
    });
    const ctx = createToolContext();

    const first = executeToolWithQueue({ tool, args: { path: "a.ts" }, ctx, queue });
    const second = executeToolWithQueue({ tool, args: { path: "b.ts" }, ctx, queue });

    await Promise.resolve();
    // No mutationKey → both start without waiting on each other.
    expect(order).toEqual(["start:a.ts", "start:b.ts", "end:b.ts"]);

    firstGate.resolve();
    await Promise.all([first, second]);
  });

  test("executeToolWithQueue serializes calls with the same mutationKey", async () => {
    const queue = new FileMutationQueue();
    const order: string[] = [];
    const firstGate = deferred<void>();
    const tool = makeTool(
      "write",
      async (args) => {
        order.push(`run:${args.path}`);
        if (args.path === "a.ts") {
          await firstGate.promise;
        }
        return { output: args.path };
      },
      () => "/project/shared.ts",
    );
    const ctx = createToolContext();

    const first = executeToolWithQueue({ tool, args: { path: "a.ts" }, ctx, queue });
    const second = executeToolWithQueue({ tool, args: { path: "b.ts" }, ctx, queue });

    await Promise.resolve();
    expect(order).toEqual(["run:a.ts"]);

    firstGate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["run:a.ts", "run:b.ts"]);
  });
});
