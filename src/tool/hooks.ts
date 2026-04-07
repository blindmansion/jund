import type {
  AfterToolCallHook,
  BeforeToolCallHook,
  ToolContext,
  ToolDef,
  ToolResult,
} from "./types.ts";

function errorResult(error: unknown): ToolResult {
  const output = error instanceof Error ? error.message : String(error);
  return { output };
}

/** @lintignore Public options type for `executeToolWithHooks`. */
export interface ExecuteToolWithHooksOptions<Params = unknown> {
  tool: ToolDef<Params>;
  args: Params;
  ctx: ToolContext;
  toolCallId: string;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
}

export async function executeToolWithHooks<Params>(
  options: ExecuteToolWithHooksOptions<Params>,
): Promise<{ result: ToolResult; isError: boolean }> {
  const { tool, args, ctx, toolCallId, beforeToolCall, afterToolCall } = options;

  const blocked = await beforeToolCall?.({
    toolName: tool.id,
    toolCallId,
    args,
    signal: ctx.abort,
  });

  if (blocked?.block) {
    return {
      result: { output: blocked.reason ?? `Tool "${tool.id}" was blocked.` },
      isError: true,
    };
  }

  let result: ToolResult;
  let isError = false;

  try {
    result = await tool.execute(args, ctx);
  } catch (error) {
    result = errorResult(error);
    isError = true;
  }

  const transformed = await afterToolCall?.({
    toolName: tool.id,
    toolCallId,
    args,
    result,
    isError,
    signal: ctx.abort,
  });

  if (transformed?.output !== undefined) {
    result = { ...result, output: transformed.output };
  }
  if (transformed?.isError !== undefined) {
    isError = transformed.isError;
  }

  return { result, isError };
}
