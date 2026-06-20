import defaultSystemPromptTemplate from "./prompts/default.txt";
import type { ToolDef } from "./tool/types.ts";

const UNIVERSAL_GUIDELINES = ["Be concise.", "Show file paths when working with files."];
export const DEFAULT_SYSTEM_PROMPT = defaultSystemPromptTemplate.trim();

export interface BuildSystemPromptOptions {
  agentPrompt: string;
  tools: ToolDef[];
  appendPrompt?: string;
  now?: Date;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const sections: string[] = [];
  const agentPrompt = options.agentPrompt.trim();
  if (agentPrompt) {
    sections.push(agentPrompt);
  }

  const snippets = options.tools
    .map((tool) => tool.promptSnippet?.trim())
    .filter((snippet): snippet is string => Boolean(snippet));
  if (snippets.length > 0) {
    sections.push(`Available tools:\n${snippets.map((snippet) => `- ${snippet}`).join("\n")}`);
  }

  const guidelines = new Set<string>(UNIVERSAL_GUIDELINES);
  for (const tool of options.tools) {
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

  if (options.appendPrompt?.trim()) {
    sections.push(options.appendPrompt.trim());
  }

  const now = options.now ?? new Date();
  sections.push(`Date: ${now.toDateString()}`);

  return sections.join("\n\n");
}
