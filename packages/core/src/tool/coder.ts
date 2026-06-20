import type { Environment } from "../types.ts";
import type { ToolDef } from "./types.ts";
import { type FileToolOptions } from "./file-tool.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createBashTool } from "./bash.ts";

export { workdirGuideline, type FileToolOptions } from "./file-tool.ts";

/**
 * Build the standard coding toolset (read, write, edit, bash) bound to a
 * filesystem/shell environment and working directory.
 *
 * ```ts
 * const tools = createCoderTools({ fs, shell }, { workdir: "/repo" });
 * const session = await createSession({ llm, tools });
 * ```
 */
export function createCoderTools(env: Environment, options: FileToolOptions): ToolDef[] {
  return [
    createReadTool(env, options),
    createWriteTool(env, options),
    createEditTool(env, options),
    createBashTool(env, options),
  ];
}
