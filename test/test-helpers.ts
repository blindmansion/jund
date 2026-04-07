import type { LLMProvider, LLMStreamEvent, LLMRequest } from "../src/llm.ts";
import type { AssistantMessage, Environment, ToolCallPart, UserMessage } from "../src/types.ts";
import type { ToolContext } from "../src/tool/types.ts";

// ── Mock LLM provider ──────────────────────────────────────────────────────
// Yields canned LLMStreamEvents from an async generator. ~20 lines, as promised.

export function createMockLLM(respond: (request: LLMRequest) => LLMStreamEvent[]): LLMProvider {
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      for (const event of respond(request)) {
        yield event;
      }
    },
  };
}

export function textResponse(text: string, tokens = { input: 100, output: 50 }): LLMStreamEvent[] {
  return [
    { type: "text-delta", text },
    { type: "finish", reason: "end-turn", tokens },
  ];
}

export function toolCallResponse(
  calls: Array<{ id: string; name: string; args: unknown }>,
  tokens = { input: 100, output: 50 },
): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = calls.map((c) => ({
    type: "tool-call" as const,
    id: c.id,
    name: c.name,
    args: c.args,
  }));
  events.push({ type: "finish", reason: "tool-calls", tokens });
  return events;
}

// ── Message fixtures ────────────────────────────────────────────────────────

let counter = 0;
function nextId(): string {
  return `test-${++counter}`;
}

export function resetIds(): void {
  counter = 0;
}

const DEFAULT_MODEL = { provider: "test", model: "mock-1" };

export function userMsg(text: string, opts?: Partial<UserMessage>): UserMessage {
  return {
    id: nextId(),
    role: "user",
    parts: [{ type: "text", text }],
    model: DEFAULT_MODEL,
    agent: "coder",
    ...opts,
  };
}

export function assistantMsg(text: string, opts?: Partial<AssistantMessage>): AssistantMessage {
  return {
    id: nextId(),
    role: "assistant",
    parts: [{ type: "text", text }],
    agent: "coder",
    model: DEFAULT_MODEL,
    finishReason: "end-turn",
    ...opts,
  };
}

export function assistantWithTools(toolCalls: ToolCallPart[], text?: string): AssistantMessage {
  const parts: AssistantMessage["parts"] = [];
  if (text) parts.push({ type: "text", text });
  parts.push(...toolCalls);
  return {
    id: nextId(),
    role: "assistant",
    parts,
    agent: "coder",
    model: DEFAULT_MODEL,
    finishReason: "tool-calls",
  };
}

export function completedToolCall(tool: string, input: unknown, output: string): ToolCallPart {
  return {
    type: "tool",
    id: nextId(),
    tool,
    input,
    state: { status: "completed", output, duration: 42 },
  };
}

export function errorToolCall(tool: string, input: unknown, error: string): ToolCallPart {
  return {
    type: "tool",
    id: nextId(),
    tool,
    input,
    state: { status: "error", error, duration: 10 },
  };
}

export function pendingToolCall(tool: string, input: unknown): ToolCallPart {
  return {
    type: "tool",
    id: nextId(),
    tool,
    input,
    state: { status: "pending" },
  };
}

export function runningToolCall(tool: string, input: unknown): ToolCallPart {
  return {
    type: "tool",
    id: nextId(),
    tool,
    input,
    state: { status: "running", startedAt: Date.now() },
  };
}

// ── Mock tool context ───────────────────────────────────────────────────────

export function createToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: "test-session",
    workdir: "/project",
    abort: new AbortController().signal,
    env: createMockEnvironment(),
    onUpdate: () => {},
    ...overrides,
  };
}

// ── Mock environment ────────────────────────────────────────────────────────

export function createMockEnvironment(files: Record<string, string> = {}): Environment {
  const store = new Map(Object.entries(files));
  const dirs = new Set<string>();

  function isDir(path: string): boolean {
    if (dirs.has(path)) return true;
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  return {
    fs: {
      async readFile(path: string) {
        const content = store.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string | Uint8Array) {
        store.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
      },
      async mkdir(path: string, _options?: { recursive?: boolean }) {
        dirs.add(path);
      },
      async exists(path: string) {
        return store.has(path) || isDir(path);
      },
      async stat(path: string) {
        if (store.has(path)) return { isFile: true, isDirectory: false };
        if (isDir(path)) return { isFile: false, isDirectory: true };
        throw new Error(`ENOENT: ${path}`);
      },
      async readdir(path: string) {
        const prefix = path.endsWith("/") ? path : path + "/";
        const entries = new Set<string>();
        for (const key of store.keys()) {
          if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            const entry = rest.split("/")[0];
            if (entry) entries.add(entry);
          }
        }
        return [...entries].sort();
      },
    },
    shell: {
      async exec(
        command: string,
        _options?: {
          cwd?: string;
          env?: Record<string, string>;
          signal?: AbortSignal;
          stdin?: string;
        },
      ) {
        const output = `mock output for: ${command}`;
        return { stdout: output, stderr: "", exitCode: 0 };
      },
    },
  };
}
