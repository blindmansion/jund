import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolDef } from "../../../src/tool/types.ts";
import {
  ToolRegistry,
  buildToolMap,
  filterToolsForAgent,
  toLLMTool,
} from "../../../src/tool/registry.ts";

function makeTool(id: string): ToolDef<{ path: string }> {
  return {
    id,
    description: `${id} description`,
    parameters: z.object({
      path: z.string(),
    }),
    async execute() {
      return { output: id };
    },
  };
}

describe("tool registry", () => {
  test("filters tools with allowlist and denylist", () => {
    const tools = [makeTool("read"), makeTool("write"), makeTool("bash")];

    const filtered = filterToolsForAgent(tools, {
      tools: ["read", "write"],
      deniedTools: ["write"],
    });

    expect(filtered.map((tool) => tool.id)).toEqual(["read"]);
  });

  test("buildToolMap indexes tools by id", () => {
    const map = buildToolMap([makeTool("read"), makeTool("write")]);

    expect(map.get("read")?.id).toBe("read");
    expect(map.get("write")?.id).toBe("write");
  });

  test("toLLMTool converts zod parameters to json schema", () => {
    const llmTool = toLLMTool(makeTool("read"));

    expect(llmTool).toMatchObject({
      name: "read",
      description: "read description",
    });
    expect(llmTool.parameters.type).toBe("object");
  });

  test("registry mutates and preserves insertion order", () => {
    const registry = new ToolRegistry([makeTool("read")]);

    registry.add(makeTool("write"));
    registry.add(makeTool("bash"));
    registry.remove("write");

    expect(registry.list().map((tool) => tool.id)).toEqual(["read", "bash"]);
    expect(registry.get("bash")?.id).toBe("bash");
  });

  test("registry can replace the full tool set", () => {
    const registry = new ToolRegistry([makeTool("read"), makeTool("write")]);

    registry.set([makeTool("edit")]);

    expect(registry.list().map((tool) => tool.id)).toEqual(["edit"]);
  });

  test("registry returns filtered maps and llm tools", () => {
    const registry = new ToolRegistry([makeTool("read"), makeTool("write"), makeTool("bash")]);

    const map = registry.mapForAgent({ deniedTools: ["bash"] });
    const llmTools = registry.toLLMTools({ tools: ["write", "bash"], deniedTools: ["bash"] });

    expect([...map.keys()]).toEqual(["read", "write"]);
    expect(llmTools.map((tool) => tool.name)).toEqual(["write"]);
  });
});
