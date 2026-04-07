import { z } from "zod";
import type { ToolDef, ToolContext, ToolResult } from "./types.ts";
import { resolvePath } from "../util/path.ts";

const ReadParams = z.object({
  path: z.string().describe("Absolute or relative path to the file or directory"),
  offset: z.number().optional().describe("Start line, 1-indexed"),
  limit: z.number().optional().describe("Maximum number of lines to return"),
});

type ReadParams = z.infer<typeof ReadParams>;

export const readTool: ToolDef<ReadParams> = {
  id: "read",
  description: "Read a file's contents with line numbers, or list a directory's entries.",
  parameters: ReadParams,

  promptSnippet: "read — Read files (with line numbers) or list directory contents.",
  promptGuidelines: ["Use offset and limit for large files instead of reading the entire file."],

  async execute(params: ReadParams, ctx: ToolContext): Promise<ToolResult> {
    const fs = ctx.env.fs;
    const fullPath = resolvePath(ctx.workdir, params.path);

    if (!(await fs.exists(fullPath))) {
      throw new Error(`File not found: ${params.path}`);
    }

    const info = await fs.stat(fullPath);

    if (info.isDirectory) {
      const entries = await fs.readdir(fullPath);
      return {
        output: entries.length > 0 ? entries.join("\n") : "(empty directory)",
        title: `Listed ${entries.length} entries in ${params.path}`,
        metadata: { path: fullPath, type: "directory", count: entries.length },
      };
    }

    const content = await fs.readFile(fullPath);
    const allLines = content.split("\n");

    const start = (params.offset ?? 1) - 1;
    const end = params.limit ? start + params.limit : allLines.length;
    const slice = allLines.slice(start, end);

    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`)
      .join("\n");

    const hasRange = params.offset != null || params.limit != null;
    const rangeInfo = hasRange
      ? ` (lines ${start + 1}-${start + slice.length} of ${allLines.length})`
      : "";

    return {
      output: numbered,
      title: `${params.path}${rangeInfo}`,
      metadata: {
        path: fullPath,
        type: "file",
        lines: slice.length,
        totalLines: allLines.length,
      },
    };
  },
};
