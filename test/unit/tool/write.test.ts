import { describe, test, expect } from "bun:test";
import { writeTool } from "../../../src/tool/write.ts";
import { createMockEnvironment, createToolContext } from "../../test-helpers.ts";

function setup(files: Record<string, string> = {}) {
  const env = createMockEnvironment(files);
  const ctx = createToolContext({ env });
  return { tool: writeTool, ctx, env };
}

describe("writeTool", () => {
  test("has correct id and metadata", () => {
    expect(writeTool.id).toBe("write");
    expect(writeTool.promptSnippet).toBeDefined();
  });

  test("creates a new file", async () => {
    const { tool, ctx, env } = setup();

    const result = await tool.execute({ path: "new.ts", content: "export const x = 1;\n" }, ctx);

    expect(result.title).toContain("Created");
    expect(result.output).toContain("+export const x = 1;");
    expect(result.metadata?.created).toBe(true);

    const written = await env.fs.readFile("/project/new.ts");
    expect(written).toBe("export const x = 1;\n");
  });

  test("overwrites an existing file and shows diff", async () => {
    const { tool, ctx, env } = setup({
      "/project/main.ts": "const a = 1;\nconst b = 2;\n",
    });

    const result = await tool.execute(
      { path: "main.ts", content: "const a = 1;\nconst b = 99;\n" },
      ctx,
    );

    expect(result.title).toContain("Updated");
    expect(result.output).toContain("-const b = 2;");
    expect(result.output).toContain("+const b = 99;");
    expect(result.metadata?.created).toBe(false);

    const written = await env.fs.readFile("/project/main.ts");
    expect(written).toBe("const a = 1;\nconst b = 99;\n");
  });

  test("returns 'No changes' when content is identical", async () => {
    const content = "same content\n";
    const { tool, ctx } = setup({ "/project/same.txt": content });

    const result = await tool.execute({ path: "same.txt", content }, ctx);
    expect(result.output).toBe("No changes.");
  });

  test("auto-creates parent directories", async () => {
    const { tool, ctx, env } = setup();

    await tool.execute({ path: "deep/nested/file.ts", content: "hi" }, ctx);

    const content = await env.fs.readFile("/project/deep/nested/file.ts");
    expect(content).toBe("hi");
  });

  test("handles absolute paths", async () => {
    const { tool, ctx, env } = setup();

    await tool.execute({ path: "/tmp/out.txt", content: "data" }, ctx);

    const content = await env.fs.readFile("/tmp/out.txt");
    expect(content).toBe("data");
  });

  test("diff shows new file header for creation", async () => {
    const { tool, ctx } = setup();

    const result = await tool.execute({ path: "brand-new.ts", content: "hello" }, ctx);
    expect(result.output).toContain("--- /dev/null");
    expect(result.output).toContain("+++ b/brand-new.ts");
  });
});
