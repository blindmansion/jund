import type { ToolContext, ToolDef, ToolResult } from "./types.ts";

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

/** @lintignore Public options type for `executeToolWithQueue`. */
export interface ExecuteToolWithQueueOptions<Params = unknown> {
  tool: ToolDef<Params>;
  args: Params;
  ctx: ToolContext;
  queue: FileMutationQueue;
}

export async function executeToolWithQueue<Params>(
  options: ExecuteToolWithQueueOptions<Params>,
): Promise<ToolResult> {
  const { tool, args, ctx, queue } = options;
  const key = tool.mutationKey?.(args);

  if (!key) {
    return tool.execute(args, ctx);
  }

  return queue.run(key, () => tool.execute(args, ctx));
}
