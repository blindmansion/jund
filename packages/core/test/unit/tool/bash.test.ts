import { describe, test, expect } from "bun:test";
import { bashTool } from "../../../src/tool/bash.ts";
import { createMockEnvironment, createToolContext } from "../../test-helpers.ts";
import type { ShellOps } from "../../../src/types.ts";

function mockShell(
  behavior?: Partial<{
    stdout: string;
    stderr: string;
    exitCode: number;
    onExec: (cmd: string, opts?: Record<string, unknown>) => void;
  }>,
): ShellOps {
  return {
    async exec(command, options) {
      behavior?.onExec?.(command, options as Record<string, unknown>);
      return {
        stdout: behavior?.stdout ?? `output: ${command}`,
        stderr: behavior?.stderr ?? "",
        exitCode: behavior?.exitCode ?? 0,
      };
    },
  };
}

function setup(shell?: ShellOps) {
  const env = createMockEnvironment();
  if (shell) {
    env.shell = shell;
  }
  const ctx = createToolContext({ env });
  return { tool: bashTool, ctx, env };
}

describe("bashTool", () => {
  test("has correct id and metadata", () => {
    expect(bashTool.id).toBe("bash");
    expect(bashTool.promptSnippet).toBeDefined();
  });

  test("executes a command and returns output", async () => {
    const { tool, ctx } = setup(mockShell({ stdout: "hello world" }));

    const result = await tool.execute({ command: "echo hello world" }, ctx);
    expect(result.output).toBe("hello world");
    expect(result.title).toContain("$ echo hello world");
    expect(result.metadata?.exitCode).toBe(0);
  });

  test("includes stderr in output", async () => {
    const { tool, ctx } = setup(mockShell({ stdout: "out", stderr: "warn" }));

    const result = await tool.execute({ command: "cmd" }, ctx);
    expect(result.output).toContain("out");
    expect(result.output).toContain("stderr:\nwarn");
  });

  test("shows exit code for non-zero exit", async () => {
    const { tool, ctx } = setup(mockShell({ stdout: "", exitCode: 1 }));

    const result = await tool.execute({ command: "false" }, ctx);
    expect(result.output).toContain("Exit code: 1");
    expect(result.metadata?.exitCode).toBe(1);
  });

  test("returns '(no output)' when empty", async () => {
    const { tool, ctx } = setup(mockShell({ stdout: "", stderr: "" }));

    const result = await tool.execute({ command: "true" }, ctx);
    expect(result.output).toBe("(no output)");
  });

  test("streams output via onUpdate", async () => {
    const chunks: string[] = [];
    const env = createMockEnvironment();
    env.shell = mockShell({ stdout: "streamed data" });
    const ctx = createToolContext({
      env,
      onUpdate: (r) => chunks.push(r.output),
    });

    await bashTool.execute({ command: "cat big.log" }, ctx);

    expect(chunks).toEqual(["streamed data"]);
  });

  test("passes cwd from context", async () => {
    let receivedCwd: string | undefined;
    const shell: ShellOps = {
      async exec(_cmd, options) {
        receivedCwd = options?.cwd;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const { tool, ctx } = setup(shell);
    await tool.execute(
      { command: "ls" },
      createToolContext({ env: { ...ctx.env, shell }, workdir: "/my/project" }),
    );

    expect(receivedCwd).toBe("/my/project");
  });

  test("passes timeout to exec", async () => {
    let receivedSignal: AbortSignal | undefined;
    const shell: ShellOps = {
      async exec(_cmd, options) {
        receivedSignal = options?.signal;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const env = createMockEnvironment();
    env.shell = shell;
    const ctx = createToolContext({ env });
    await bashTool.execute({ command: "sleep 10", timeout: 5000 }, ctx);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal).not.toBe(ctx.abort);
  });

  test("propagates abort from context", async () => {
    let receivedSignal: AbortSignal | undefined;
    const shell: ShellOps = {
      async exec(_cmd, options) {
        receivedSignal = options?.signal;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const controller = new AbortController();
    controller.abort();
    const env = createMockEnvironment();
    env.shell = shell;
    const ctx = createToolContext({ env, abort: controller.signal });
    await bashTool.execute({ command: "ls" }, ctx);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("truncates long commands in title", async () => {
    const { tool, ctx } = setup(mockShell());

    const longCmd = "a".repeat(100);
    const result = await tool.execute({ command: longCmd }, ctx);
    expect(result.title!.length).toBeLessThan(90);
    expect(result.title).toContain("...");
  });
});
