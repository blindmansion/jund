import { describe, test, expect } from "bun:test";
import { createEditTool, normalizeEditArgs } from "../../../src/tool/edit.ts";
import { createMockEnvironment, createToolContext } from "../../test-helpers.ts";

function setup(files: Record<string, string> = {}) {
  const env = createMockEnvironment(files);
  const tool = createEditTool(env, { workdir: "/project" });
  const ctx = createToolContext();
  return { tool, ctx, env };
}

describe("editTool", () => {
  test("has correct id and metadata", () => {
    const { tool } = setup();
    expect(tool.id).toBe("edit");
    expect(tool.promptSnippet).toBeDefined();
    expect(tool.prepareArgs).toBe(normalizeEditArgs);
  });

  test("applies a single edit", async () => {
    const { tool, ctx, env } = setup({
      "/project/file.ts": "const x = 1;\nconst y = 2;\nconst z = 3;\n",
    });

    const result = await tool.execute(
      {
        path: "file.ts",
        edits: [{ oldText: "const y = 2;", newText: "const y = 99;" }],
      },
      ctx,
    );

    expect(result.output).toContain("-const y = 2;");
    expect(result.output).toContain("+const y = 99;");
    expect(result.title).toContain("1 edit");

    const content = await env.fs.readFile("/project/file.ts");
    expect(content).toContain("const y = 99;");
    expect(content).toContain("const x = 1;");
    expect(content).toContain("const z = 3;");
  });

  test("applies multiple edits against the original", async () => {
    const { tool, ctx, env } = setup({
      "/project/file.ts": "aaa\nbbb\nccc\nddd\neee\n",
    });

    const result = await tool.execute(
      {
        path: "file.ts",
        edits: [
          { oldText: "bbb", newText: "BBB" },
          { oldText: "ddd", newText: "DDD" },
        ],
      },
      ctx,
    );

    expect(result.output).toContain("-bbb");
    expect(result.output).toContain("+BBB");
    expect(result.output).toContain("-ddd");
    expect(result.output).toContain("+DDD");
    expect(result.title).toContain("2 edits");

    const content = await env.fs.readFile("/project/file.ts");
    expect(content).toBe("aaa\nBBB\nccc\nDDD\neee\n");
  });

  test("edits can change line count", async () => {
    const { tool, ctx, env } = setup({
      "/project/file.ts": "line 1\nline 2\nline 3\n",
    });

    await tool.execute(
      {
        path: "file.ts",
        edits: [{ oldText: "line 2", newText: "line 2a\nline 2b\nline 2c" }],
      },
      ctx,
    );

    const content = await env.fs.readFile("/project/file.ts");
    expect(content).toBe("line 1\nline 2a\nline 2b\nline 2c\nline 3\n");
  });

  test("throws when oldText is not found", async () => {
    const { tool, ctx } = setup({
      "/project/file.ts": "hello world",
    });

    expect(
      tool.execute({ path: "file.ts", edits: [{ oldText: "not here", newText: "x" }] }, ctx),
    ).rejects.toThrow("could not find oldText");
  });

  test("throws when oldText matches multiple locations", async () => {
    const { tool, ctx } = setup({
      "/project/file.ts": "foo\nbar\nfoo\n",
    });

    expect(
      tool.execute({ path: "file.ts", edits: [{ oldText: "foo", newText: "baz" }] }, ctx),
    ).rejects.toThrow("matches multiple locations");
  });

  test("throws when edits overlap", async () => {
    const { tool, ctx } = setup({
      "/project/file.ts": "abcdefghij",
    });

    expect(
      tool.execute(
        {
          path: "file.ts",
          edits: [
            { oldText: "abcdef", newText: "X" },
            { oldText: "defghij", newText: "Y" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow("overlap");
  });

  test("throws for missing file", async () => {
    const { tool, ctx } = setup();

    expect(
      tool.execute({ path: "nope.ts", edits: [{ oldText: "x", newText: "y" }] }, ctx),
    ).rejects.toThrow("File not found");
  });

  test("returns 'No changes' when oldText equals newText", async () => {
    const { tool, ctx } = setup({
      "/project/file.ts": "const x = 1;",
    });

    const result = await tool.execute(
      { path: "file.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 1;" }] },
      ctx,
    );

    expect(result.output).toBe("No changes.");
  });
});

// ── normalizeEditArgs ───────────────────────────────────────────────────────

describe("normalizeEditArgs", () => {
  test("wraps flat oldText/newText into edits array", () => {
    const result = normalizeEditArgs({
      path: "file.ts",
      oldText: "old",
      newText: "new",
    });

    expect(result).toEqual({
      path: "file.ts",
      edits: [{ oldText: "old", newText: "new" }],
    });
  });

  test("passes through args that already have edits", () => {
    const input = {
      path: "file.ts",
      edits: [{ oldText: "a", newText: "b" }],
    };

    expect(normalizeEditArgs(input)).toBe(input);
  });

  test("passes through non-object args", () => {
    expect(normalizeEditArgs("hello")).toBe("hello");
    expect(normalizeEditArgs(42)).toBe(42);
    expect(normalizeEditArgs(null)).toBe(null);
  });

  test("preserves extra properties during normalization", () => {
    const result = normalizeEditArgs({
      path: "file.ts",
      oldText: "old",
      newText: "new",
      extra: "keep",
    });

    expect(result).toEqual({
      path: "file.ts",
      edits: [{ oldText: "old", newText: "new" }],
      extra: "keep",
    });
  });
});
