import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CODER_AGENT } from "../../src/agent.ts";
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "../../src/prompt.ts";
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
    expect(CODER_AGENT.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("includes tool snippets, deduped guidelines, and runtime context", () => {
    const prompt = buildSystemPrompt({
      agentPrompt: "You are helpful.",
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
      workdir: "/project",
      appendPrompt: "Host note.",
      now: new Date("2026-04-05T12:00:00Z"),
    });

    expect(prompt).toContain("You are helpful.");
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- read - inspect files");
    expect(prompt).toContain("- bash - run shell commands");
    expect(prompt).toContain("Guidelines:");
    expect(prompt.match(/Use offsets for large files\./g)).toHaveLength(1);
    expect(prompt).toContain("Host note.");
    expect(prompt).toContain("Date: Sun Apr 05 2026");
    expect(prompt).toContain("Working directory: /project");
  });

  test("omits empty sections cleanly", () => {
    const prompt = buildSystemPrompt({
      agentPrompt: "Base prompt.",
      tools: [makeTool("read")],
      workdir: "/project",
      now: new Date("2026-04-05T12:00:00Z"),
    });

    expect(prompt).toContain("Base prompt.");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).toContain("Guidelines:");
  });
});
