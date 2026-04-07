import { describe, test, expect } from "bun:test";
import { AgentError } from "../../src/types.ts";
import { createMockEnvironment } from "../test-helpers.ts";

// ── AgentError ──────────────────────────────────────────────────────────────

describe("AgentError", () => {
  test("constructs with message, code, and default non-retryable", () => {
    const err = new AgentError("something broke", "TOOL_EXEC");
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("TOOL_EXEC");
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("AgentError");
  });

  test("constructs with retryable flag", () => {
    const err = new AgentError("rate limited", "RATE_LIMIT", true);
    expect(err.retryable).toBe(true);
  });

  test("is instanceof Error", () => {
    const err = new AgentError("test", "TEST");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AgentError).toBe(true);
  });
});

// ── Mock environment sanity checks ──────────────────────────────────────────

describe("createMockEnvironment", () => {
  test("readFile returns content for existing files", async () => {
    const env = createMockEnvironment({ "/a.txt": "aaa" });
    expect(await env.fs.readFile("/a.txt")).toBe("aaa");
  });

  test("readFile throws for missing files", async () => {
    const env = createMockEnvironment();
    expect(env.fs.readFile("/missing")).rejects.toThrow("ENOENT");
  });

  test("writeFile creates a new file", async () => {
    const env = createMockEnvironment();
    await env.fs.writeFile("/new.txt", "hello");
    expect(await env.fs.readFile("/new.txt")).toBe("hello");
  });

  test("exists returns true/false correctly", async () => {
    const env = createMockEnvironment({ "/yes.txt": "y" });
    expect(await env.fs.exists("/yes.txt")).toBe(true);
    expect(await env.fs.exists("/no.txt")).toBe(false);
  });

  test("readdir lists direct children", async () => {
    const env = createMockEnvironment({
      "/src/a.ts": "a",
      "/src/nested/b.ts": "b",
    });
    expect(await env.fs.readdir("/src")).toEqual(["a.ts", "nested"]);
  });

  test("shell exec returns mock output", async () => {
    const env = createMockEnvironment();
    const result = await env.shell.exec("echo hi");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("echo hi");
  });
});
