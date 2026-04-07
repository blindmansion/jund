import { z } from "zod";
import type { AgentConfig } from "../agent.ts";
import type { LLMToolDef } from "../llm.ts";
import type { ToolDef } from "./types.ts";

type ToolAccess = Pick<AgentConfig, "tools" | "deniedTools"> | undefined;

function toJsonSchema(parameters: ToolDef["parameters"]): Record<string, unknown> {
  return z.toJSONSchema(parameters) as Record<string, unknown>;
}

export function filterToolsForAgent(tools: ToolDef[], agent?: ToolAccess): ToolDef[] {
  const denied = new Set(agent?.deniedTools ?? []);
  const allowed = agent?.tools ? new Set(agent.tools) : undefined;

  return tools.filter((tool) => {
    if (denied.has(tool.id)) return false;
    if (!allowed) return true;
    return allowed.has(tool.id);
  });
}

export function buildToolMap(tools: ToolDef[]): Map<string, ToolDef> {
  return new Map(tools.map((tool) => [tool.id, tool]));
}

export function toLLMTool(tool: ToolDef): LLMToolDef {
  return {
    name: tool.id,
    description: tool.description,
    parameters: toJsonSchema(tool.parameters),
  };
}

export class ToolRegistry {
  #tools = new Map<string, ToolDef>();

  constructor(initialTools: ToolDef[] = []) {
    this.set(initialTools);
  }

  add(tool: ToolDef): void {
    this.#tools.set(tool.id, tool);
  }

  remove(id: string): void {
    this.#tools.delete(id);
  }

  set(tools: ToolDef[]): void {
    this.#tools = buildToolMap(tools);
  }

  get(id: string): ToolDef | undefined {
    return this.#tools.get(id);
  }

  list(): ToolDef[] {
    return [...this.#tools.values()];
  }

  listForAgent(agent?: ToolAccess): ToolDef[] {
    return filterToolsForAgent(this.list(), agent);
  }

  mapForAgent(agent?: ToolAccess): Map<string, ToolDef> {
    return buildToolMap(this.listForAgent(agent));
  }

  toLLMTools(agent?: ToolAccess): LLMToolDef[] {
    return this.listForAgent(agent).map(toLLMTool);
  }
}
