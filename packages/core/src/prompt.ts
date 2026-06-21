import defaultSystemPromptTemplate from "./prompts/default.txt";
import type { ToolDef } from "./tool/types.ts";

/**
 * Opinionated guidelines jund used to inject into every prompt. They are no
 * longer applied automatically — pass them to `buildSystemPrompt` if you want
 * them.
 */
export const UNIVERSAL_GUIDELINES = ["Be concise.", "Show file paths when working with files."];
export const DEFAULT_SYSTEM_PROMPT = defaultSystemPromptTemplate.trim();

export interface BuildSystemPromptOptions {
  /** The base prompt text (e.g. the agent persona). */
  base: string;
  /** Tools whose `promptSnippet` / `promptGuidelines` get folded in. */
  tools?: ToolDef[];
  /** Extra guidelines to include (e.g. `UNIVERSAL_GUIDELINES`). Opt-in. */
  guidelines?: string[];
  /** When provided, appends a `Date: ...` line. Opt-in. */
  now?: Date;
}

/**
 * Opt-in helper for assembling a system prompt from a base string, tool
 * snippets/guidelines, and an optional date line. The session never calls this
 * automatically — wire it into a `systemPrompt` resolver if you want it.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const sections: string[] = [];
  const base = options.base.trim();
  if (base) {
    sections.push(base);
  }

  const tools = options.tools ?? [];
  const snippets = tools
    .map((tool) => tool.promptSnippet?.trim())
    .filter((snippet): snippet is string => Boolean(snippet));
  if (snippets.length > 0) {
    sections.push(`Available tools:\n${snippets.map((snippet) => `- ${snippet}`).join("\n")}`);
  }

  const guidelines = new Set<string>(options.guidelines ?? []);
  for (const tool of tools) {
    for (const guideline of tool.promptGuidelines ?? []) {
      const text = guideline.trim();
      if (text) guidelines.add(text);
    }
  }
  if (guidelines.size > 0) {
    sections.push(
      `Guidelines:\n${[...guidelines].map((guideline) => `- ${guideline}`).join("\n")}`,
    );
  }

  if (options.now) {
    sections.push(`Date: ${options.now.toDateString()}`);
  }

  return sections.join("\n\n");
}
