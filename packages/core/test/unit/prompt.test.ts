import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  UNIVERSAL_GUIDELINES,
} from "../../src/prompt.ts";
import type { ToolDef } from "../../src/tool/types.ts";

function makeTool(
  id: string,
  options: Partial<Pick<ToolDef, "promptSnippet" | "promptGuidelines">> = {},
): ToolDef {
  return {
    id,
    description: `${id} description`,
    parameters: z.object({ value: z.string().optional() }),
    promptSnippet: options.promptSnippet,
    promptGuidelines: options.promptGuidelines,
    async execute() {
      return { output: id };
    },
  };
}

describe("buildSystemPrompt", () => {
  test("exports the default coder prompt template", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("host-controlled agent harness");
    expect(DEFAULT_SYSTEM_PROMPT.endsWith("\n")).toBe(false);
  });

  test("includes tool snippets, deduped guidelines, and optional date", () => {
    const prompt = buildSystemPrompt({
      base: "You are helpful.",
      tools: [
        makeTool("read", {
          promptSnippet: "read - inspect files",
          promptGuidelines: ["Use offsets for large files.", "Be concise."],
        }),
        makeTool("bash", {
          promptSnippet: "bash - run shell commands",
          promptGuidelines: ["Use offsets for large files."],
        }),
      ],
      guidelines: UNIVERSAL_GUIDELINES,
      now: new Date("2026-04-05T12:00:00Z"),
    });

    expect(prompt).toContain("You are helpful.");
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- read - inspect files");
    expect(prompt).toContain("- bash - run shell commands");
    expect(prompt).toContain("Guidelines:");
    expect(prompt.match(/Use offsets for large files\./g)).toHaveLength(1);
    expect(prompt).toContain("Date: Sun Apr 05 2026");
  });

  test("omits opt-in sections cleanly", () => {
    const prompt = buildSystemPrompt({
      base: "Base prompt.",
      tools: [makeTool("read")],
    });

    expect(prompt).toBe("Base prompt.");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).not.toContain("Guidelines:");
    expect(prompt).not.toContain("Date:");
  });
});
