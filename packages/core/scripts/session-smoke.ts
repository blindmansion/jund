import assert from "node:assert/strict";
import { anthropic } from "@ai-sdk/anthropic";
import { createAISDKProvider } from "../src/adapters/ai-sdk.ts";
import {
  createCoderTools,
  createSession,
  getAssistantText,
  type Environment,
  type LLMProviderWithModel,
} from "../src/index.ts";

const MODEL_ID = process.env.LIVE_LLM_MODEL ?? "claude-sonnet-4-20250514";

function createMemoryEnvironment(files: Record<string, string>): Environment {
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
        if (content == null) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string | Uint8Array) {
        store.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
      },
      async mkdir(path: string) {
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
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const entry = rest.split("/")[0];
          if (entry) entries.add(entry);
        }
        return [...entries].sort();
      },
    },
    shell: {
      async exec(command: string) {
        return { stdout: `mock output for: ${command}`, stderr: "", exitCode: 0 };
      },
    },
  };
}

async function runPlainTextScenario(llm: LLMProviderWithModel): Promise<void> {
  console.log("\n[plain-text] starting");
  const session = await createSession({ llm });

  const result = await session.prompt("Reply with a short greeting.");
  const text = getAssistantText(result).trim();

  assert.notEqual(text, "", "plain-text scenario should produce text");
  assert.notEqual(result.finishReason, "tool-calls", "plain-text scenario should finish the turn");
  console.log("[plain-text] ok:", text);
}

async function runToolScenario(llm: LLMProviderWithModel): Promise<void> {
  console.log("\n[tool-loop] starting");
  const session = await createSession({
    llm,
    tools: createCoderTools(
      createMemoryEnvironment({
        "/project/note.txt": "hello from the smoke test",
      }),
      { workdir: "/project" },
    ),
    systemPrompt: "When asked about a file, use the read tool before answering.",
  });

  const result = await session.prompt(
    "Use the read tool to inspect note.txt, then answer in one short sentence.",
  );
  const text = getAssistantText(result).trim();

  const usedReadTool = session
    .messages()
    .some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "read"),
    );

  assert.equal(usedReadTool, true, "tool-loop scenario should issue a read tool call");
  assert.notEqual(text, "", "tool-loop scenario should produce final assistant text");
  console.log("[tool-loop] ok:", text);
}

async function runSubagentScenario(llm: LLMProviderWithModel): Promise<void> {
  console.log("\n[subagent] starting");
  const session = await createSession({
    llm,
    tools: createCoderTools(
      createMemoryEnvironment({
        "/project/note.txt": "delegated hello from the smoke test",
      }),
      { workdir: "/project" },
    ),
    systemPrompt:
      "When a focused read-only lookup is enough, delegate with the task tool and let the explorer subagent inspect files.",
  });

  const result = await session.prompt(
    "Use the task tool to delegate reading note.txt, then answer with one short sentence.",
  );
  const text = getAssistantText(result).trim();

  const usedTaskTool = session
    .messages()
    .some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "task"),
    );

  assert.equal(usedTaskTool, true, "subagent scenario should issue a task tool call");
  assert.notEqual(text, "", "subagent scenario should produce final assistant text");
  console.log("[subagent] ok:", text);
}

async function main() {
  if (process.env.RUN_LIVE_LLM !== "1") {
    console.log("Skipping live LLM smoke run. Set RUN_LIVE_LLM=1 to enable.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("Skipping live LLM smoke run. Set ANTHROPIC_API_KEY first.");
    return;
  }

  console.log(`Running session smoke tests with ${MODEL_ID}`);
  const llm = createAISDKProvider({
    model: anthropic(MODEL_ID),
    id: `anthropic:${MODEL_ID}`,
    name: MODEL_ID,
    contextLimit: 200_000,
    outputLimit: 16_384,
    capabilities: { reasoning: true, toolCalls: true, images: false },
  });

  await runPlainTextScenario(llm);
  await runToolScenario(llm);
  await runSubagentScenario(llm);

  console.log("\nAll smoke scenarios passed.");
}

main().catch((error) => {
  console.error("\nSmoke run failed:");
  console.error(error);
  process.exitCode = 1;
});
