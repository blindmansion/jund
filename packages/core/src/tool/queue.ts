import { resolvePath } from "../util/path.ts";
import type { ToolContext, ToolDef, ToolResult } from "./types.ts";

function isPathParams(args: unknown): args is { path: string } {
  return (
    typeof args === "object" && args !== null && "path" in args && typeof args.path === "string"
  );
}

export class FileMutationQueue {
  #locks = new Map<string, Promise<void>>();

  async run<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(path);

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(path, current);

    if (previous) {
      await previous.catch(() => undefined);
    }

    try {
      return await task();
    } finally {
      release();
      if (this.#locks.get(path) === current) {
        this.#locks.delete(path);
      }
    }
  }
}

export function getBuiltInMutationPath(
  tool: ToolDef,
  args: unknown,
  ctx: ToolContext,
): string | undefined {
  if ((tool.id !== "write" && tool.id !== "edit") || !isPathParams(args)) {
    return undefined;
  }

  return resolvePath(ctx.workdir, args.path);
}

/** @lintignore Public options type for `executeToolWithQueue`. */
export interface ExecuteToolWithQueueOptions<Params = unknown> {
  tool: ToolDef<Params>;
  args: Params;
  ctx: ToolContext;
  queue: FileMutationQueue;
  resolvePath?: (
    tool: ToolDef<Params>,
    args: Params,
    ctx: ToolContext,
  ) => string | Promise<string | undefined> | undefined;
}

export async function executeToolWithQueue<Params>(
  options: ExecuteToolWithQueueOptions<Params>,
): Promise<ToolResult> {
  const {
    tool,
    args,
    ctx,
    queue,
    resolvePath: resolveMutationPath = getBuiltInMutationPath,
  } = options;
  const path = await resolveMutationPath(tool, args, ctx);

  if (!path) {
    return tool.execute(args, ctx);
  }

  return queue.run(path, () => tool.execute(args, ctx));
}
