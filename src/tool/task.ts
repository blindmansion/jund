import { z } from "zod";
import { getAssistantText } from "../util/message.ts";
import type { ToolDef, ToolContext, ToolResult } from "./types.ts";

const TaskParams = z.object({
  prompt: z.string().describe("The task prompt to send to the subagent"),
  agent: z
    .string()
    .optional()
    .describe("Optional agent name. Defaults to the built-in explorer subagent."),
});

export type TaskParams = z.infer<typeof TaskParams>;

export const taskTool: ToolDef<TaskParams> = {
  id: "task",
  description: "Delegate work to a child subagent and return its final answer.",
  parameters: TaskParams,

  promptSnippet: "task — Delegate a focused task to a subagent.",
  promptGuidelines: [
    "Use task for focused subproblems that can be solved independently.",
    "Write the subagent prompt clearly since the child does not inherit the full parent conversation.",
  ],

  async execute(params: TaskParams, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.spawnSubagent) {
      throw new Error("Subagent spawning is not available in this context.");
    }

    const result = await ctx.spawnSubagent({
      prompt: params.prompt,
      agent: params.agent,
      signal: ctx.abort,
      onUpdate(chunk) {
        ctx.onUpdate({ output: chunk });
      },
    });

    if (result.message.error) {
      throw result.message.error;
    }

    const output = getAssistantText(result.message) || "(no output)";

    return {
      output,
      title: `${result.agent} subagent`,
      metadata: {
        sessionId: result.sessionId,
        agent: result.agent,
        finishReason: result.message.finishReason,
      },
    };
  },
};
