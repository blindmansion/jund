import { z } from "zod";
import type { ToolDef, ToolContext, ToolResult } from "./types.ts";
import type { Environment } from "../types.ts";
import { resolvePath } from "../util/path.ts";
import { unifiedDiff } from "../util/diff.ts";
import { workdirGuideline, type FileToolOptions } from "./file-tool.ts";

const WriteParams = z.object({
  path: z.string().describe("Path to the file to create or overwrite"),
  content: z.string().describe("The full content to write to the file"),
});

type WriteParams = z.infer<typeof WriteParams>;

export function createWriteTool(env: Environment, options: FileToolOptions): ToolDef<WriteParams> {
  const { workdir } = options;
  return {
    id: "write",
    description:
      "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: WriteParams,

    promptSnippet: "write — Create or overwrite a file. Returns a diff of the changes.",
    promptGuidelines: [
      "Prefer the edit tool for modifying existing files — write replaces the entire file.",
      workdirGuideline(workdir),
    ],

    mutationKey: (params) => resolvePath(workdir, params.path),

    async execute(params: WriteParams, _ctx: ToolContext): Promise<ToolResult> {
      const fs = env.fs;
      const fullPath = resolvePath(workdir, params.path);

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
}
