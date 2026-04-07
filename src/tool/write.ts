import { z } from "zod";
import type { ToolDef, ToolContext, ToolResult } from "./types.ts";
import { resolvePath } from "../util/path.ts";
import { unifiedDiff } from "../util/diff.ts";

const WriteParams = z.object({
  path: z.string().describe("Path to the file to create or overwrite"),
  content: z.string().describe("The full content to write to the file"),
});

type WriteParams = z.infer<typeof WriteParams>;

export const writeTool: ToolDef<WriteParams> = {
  id: "write",
  description:
    "Create or overwrite a file with the given content. Parent directories are created automatically.",
  parameters: WriteParams,

  promptSnippet: "write — Create or overwrite a file. Returns a diff of the changes.",
  promptGuidelines: [
    "Prefer the edit tool for modifying existing files — write replaces the entire file.",
  ],

  async execute(params: WriteParams, ctx: ToolContext): Promise<ToolResult> {
    const fs = ctx.env.fs;
    const fullPath = resolvePath(ctx.workdir, params.path);

    let oldContent = "";
    const existed = await fs.exists(fullPath);
    if (existed) {
      oldContent = await fs.readFile(fullPath);
    }

    const lastSlash = fullPath.lastIndexOf("/");
    if (lastSlash > 0) {
      await fs.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
    }

    await fs.writeFile(fullPath, params.content);

    const diff = unifiedDiff(oldContent, params.content, params.path);
    const lineCount = params.content.split("\n").length;

    return {
      output: diff || "No changes.",
      title: existed ? `Updated ${params.path}` : `Created ${params.path} (${lineCount} lines)`,
      metadata: { path: fullPath, created: !existed },
    };
  },
};
