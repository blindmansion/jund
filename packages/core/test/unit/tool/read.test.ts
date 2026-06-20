import { describe, test, expect } from "bun:test";
import { createReadTool } from "../../../src/tool/read.ts";
import { createMockEnvironment, createToolContext } from "../../test-helpers.ts";

function setup(files: Record<string, string> = {}) {
  const env = createMockEnvironment(files);
  const tool = createReadTool(env, { workdir: "/project" });
  const ctx = createToolContext();
  return { tool, ctx, env };
}

describe("readTool", () => {
  test("has correct id and metadata", () => {
    const { tool } = setup();
    expect(tool.id).toBe("read");
    expect(tool.promptSnippet).toBeDefined();
  });

  test("reads a file with line numbers", async () => {
    const { tool, ctx } = setup({
      "/project/hello.txt": "line one\nline two\nline three",
    });

    const result = await tool.execute({ path: "hello.txt" }, ctx);
    expect(result.output).toContain("1|line one");
    expect(result.output).toContain("2|line two");
    expect(result.output).toContain("3|line three");
  });

  test("reads with offset and limit", async () => {
    const { tool, ctx } = setup({
      "/project/big.txt": "a\nb\nc\nd\ne\nf",
    });

    const result = await tool.execute({ path: "big.txt", offset: 2, limit: 3 }, ctx);
    expect(result.output).toContain("2|b");
    expect(result.output).toContain("3|c");
    expect(result.output).toContain("4|d");
    expect(result.output).not.toContain("1|a");
    expect(result.output).not.toContain("5|e");
  });

  test("includes range info in title when offset/limit used", async () => {
    const { tool, ctx } = setup({
      "/project/big.txt": "a\nb\nc\nd\ne",
    });

    const result = await tool.execute({ path: "big.txt", offset: 2, limit: 2 }, ctx);
    expect(result.title).toContain("lines 2-3 of 5");
  });

  test("lists a directory", async () => {
    const { tool, ctx } = setup({
      "/project/src/a.ts": "a",
      "/project/src/b.ts": "b",
      "/project/src/lib/c.ts": "c",
    });

    const result = await tool.execute({ path: "src" }, ctx);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
    expect(result.output).toContain("lib");
    expect(result.metadata?.type).toBe("directory");
  });

  test("shows empty directory message", async () => {
    const env = createMockEnvironment();
    await env.fs.mkdir("/project/empty");
    const tool = createReadTool(env, { workdir: "/project" });

    const result = await tool.execute({ path: "empty" }, createToolContext());
    expect(result.output).toBe("(empty directory)");
  });

  test("throws for missing file", async () => {
    const { tool, ctx } = setup();

    expect(tool.execute({ path: "nope.txt" }, ctx)).rejects.toThrow("File not found");
  });

  test("reads an empty file", async () => {
    const { tool, ctx } = setup({ "/project/empty.txt": "" });

    const result = await tool.execute({ path: "empty.txt" }, ctx);
    expect(result.output).toContain("1|");
    expect(result.metadata?.totalLines).toBe(1);
  });

  test("resolves absolute paths", async () => {
    const { tool, ctx } = setup({ "/etc/config": "key=value" });

    const result = await tool.execute({ path: "/etc/config" }, ctx);
    expect(result.output).toContain("key=value");
  });

  test("metadata includes line counts", async () => {
    const { tool, ctx } = setup({
      "/project/file.ts": "a\nb\nc\nd\ne",
    });

    const result = await tool.execute({ path: "file.ts" }, ctx);
    expect(result.metadata?.lines).toBe(5);
    expect(result.metadata?.totalLines).toBe(5);
  });
});
