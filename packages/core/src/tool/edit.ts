import { z } from "zod";
import type { ToolDef, ToolContext, ToolResult } from "./types.ts";
import type { Environment } from "../types.ts";
import { resolvePath } from "../util/path.ts";
import { unifiedDiff } from "../util/diff.ts";
import { workdirGuideline, type FileToolOptions } from "./file-tool.ts";

const EditEntry = z.object({
  oldText: z.string().describe("Exact text to find in the original file"),
  newText: z.string().describe("Replacement text"),
});

const EditParams = z.object({
  path: z.string().describe("Path to the file to edit"),
  edits: z
    .array(EditEntry)
    .describe(
      "Edits to apply. Each is matched against the original file content, not incrementally.",
    ),
});

type EditParams = z.infer<typeof EditParams>;

export function normalizeEditArgs(args: unknown): unknown {
  if (
    typeof args === "object" &&
    args !== null &&
    "path" in args &&
    "oldText" in args &&
    "newText" in args &&
    !("edits" in args)
  ) {
    const { path, oldText, newText, ...rest } = args as Record<string, unknown>;
    return { path, edits: [{ oldText, newText }], ...rest };
  }
  return args;
}

function applyEdits(content: string, edits: EditParams["edits"]): string {
  const positioned = edits.map((edit, i) => {
    const idx = content.indexOf(edit.oldText);
    if (idx === -1) {
      throw new Error(
        `Edit ${i + 1}: could not find oldText in file. ` +
          `Searched for: ${JSON.stringify(edit.oldText.slice(0, 100))}`,
      );
    }
    const secondIdx = content.indexOf(edit.oldText, idx + 1);
    if (secondIdx !== -1) {
      throw new Error(
        `Edit ${i + 1}: oldText matches multiple locations. Add more surrounding context to make it unique.`,
      );
    }
    return { ...edit, start: idx, end: idx + edit.oldText.length };
  });

  positioned.sort((a, b) => a.start - b.start);

  for (let i = 1; i < positioned.length; i++) {
    if (positioned[i]!.start < positioned[i - 1]!.end) {
      throw new Error(`Edits ${i} and ${i + 1} overlap. Merge them into a single edit.`);
    }
  }

  let result = "";
  let cursor = 0;
  for (const edit of positioned) {
    result += content.slice(cursor, edit.start);
    result += edit.newText;
    cursor = edit.end;
  }
  result += content.slice(cursor);

  return result;
}

export function createEditTool(env: Environment, options: FileToolOptions): ToolDef<EditParams> {
  const { workdir } = options;
  return {
    id: "edit",
    description:
      "Apply find-and-replace edits to a file. Each edit is matched against the original file content, not incrementally. " +
      "Do not include overlapping edits. If two changes touch nearby lines, merge them into one edit.",
    parameters: EditParams,
    prepareArgs: normalizeEditArgs,

    promptSnippet: "edit — Apply find-and-replace edits to a file. Returns a diff.",
    promptGuidelines: [
      "Each edit is matched against the original file. Do not account for earlier edits when writing later ones.",
      "If two edits touch nearby or overlapping text, merge them into a single edit.",
      "Include enough surrounding context in oldText to uniquely identify the location.",
      workdirGuideline(workdir),
    ],

    mutationKey: (params) => resolvePath(workdir, params.path),

    async execute(params: EditParams, _ctx: ToolContext): Promise<ToolResult> {
      const fs = env.fs;
      const fullPath = resolvePath(workdir, params.path);

      if (!(await fs.exists(fullPath))) {
        throw new Error(`File not found: ${params.path}`);
      }

      const original = await fs.readFile(fullPath);
      const modified = applyEdits(original, params.edits);

      await fs.writeFile(fullPath, modified);

      const diff = unifiedDiff(original, modified, params.path);

      return {
        output: diff || "No changes.",
        title: `Edited ${params.path} (${params.edits.length} edit${params.edits.length > 1 ? "s" : ""})`,
        metadata: { path: fullPath, editCount: params.edits.length },
      };
    },
  };
}
