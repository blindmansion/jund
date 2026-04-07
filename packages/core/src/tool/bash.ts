import { z } from "zod";
import type { ToolDef, ToolContext, ToolResult } from "./types.ts";

const BashParams = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in milliseconds. The command is killed if it exceeds this."),
});

type BashParams = z.infer<typeof BashParams>;

export const bashTool: ToolDef<BashParams> = {
  id: "bash",
  description: "Execute a shell command and return its output.",
  parameters: BashParams,

  promptSnippet: "bash — Run shell commands.",
  promptGuidelines: [
    "Prefer read/edit tools for file operations over bash when available.",
    "Use timeout for potentially long-running commands.",
  ],

  async execute(params: BashParams, ctx: ToolContext): Promise<ToolResult> {
    const shell = ctx.env.shell;

    const timeoutController = new AbortController();
    const parentSignal = ctx.abort;
    const forwardAbort = () => timeoutController.abort();

    if (parentSignal.aborted) {
      timeoutController.abort();
    } else {
      parentSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    const timeoutId =
      params.timeout == null
        ? undefined
        : setTimeout(() => {
            timeoutController.abort();
          }, params.timeout);

    let result;
    try {
      result = await shell.exec(params.command, {
        cwd: ctx.workdir,
        signal: timeoutController.signal,
      });
    } finally {
      if (timeoutId != null) {
        clearTimeout(timeoutId);
      }
      parentSignal.removeEventListener("abort", forwardAbort);
    }

    let output = "";
    if (result.stdout) output += result.stdout;
    if (result.stderr) {
      if (output) output += "\n";
      output += `stderr:\n${result.stderr}`;
    }
    if (result.exitCode !== 0) {
      output += `\n\nExit code: ${result.exitCode}`;
    }

    if (result.stdout) {
      ctx.onUpdate({ output: result.stdout });
    }
    if (result.stderr) {
      ctx.onUpdate({ output: result.stderr });
    }

    const cmdPreview =
      params.command.length > 80 ? params.command.slice(0, 77) + "..." : params.command;

    return {
      output: output || "(no output)",
      title: `$ ${cmdPreview}`,
      metadata: { exitCode: result.exitCode, command: params.command },
    };
  },
};
