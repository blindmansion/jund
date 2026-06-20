import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Bash, ReadWriteFs } from "just-bash";
import { anthropic } from "@ai-sdk/anthropic";
import { createAISDKProvider } from "../src/adapters/ai-sdk.ts";
import {
  createCoderTools,
  createSession,
  getAssistantText,
  type Environment,
} from "../src/index.ts";
import {
  createDemoLogger,
  ensureAnthropicKey,
  getLiveModel,
  printToolSummary,
} from "./demo-helpers.ts";

const hostRoot = path.join(process.cwd(), ".tmp", "demo-interactive");
const workdir = "/";

async function seedWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "demo-project",
        version: "0.1.0",
        type: "module",
        scripts: { start: "bun src/index.ts", test: "bun test" },
      },
      null,
      2,
    ) + "\n",
  );

  await writeFile(
    path.join(root, "README.md"),
    ["# Demo Project", "", "A small TypeScript project for interactive testing.", ""].join("\n"),
  );

  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}!`;",
      "}",
      "",
      'console.log(greet("world"));',
      "",
    ].join("\n"),
  );
}

function askOnce(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  if (!ensureAnthropicKey()) return;

  const userPrompt = await askOnce("\nWhat should the agent do?\n> ");
  if (!userPrompt) {
    console.log("Empty prompt, exiting.");
    return;
  }

  console.log("\nSeeding workspace...");
  await seedWorkspace(hostRoot);

  const fs = new ReadWriteFs({ root: hostRoot });
  const shell = new Bash({ fs, cwd: workdir });
  const env: Environment = { fs, shell };

  const model = getLiveModel();
  const llm = createAISDKProvider({ model: anthropic(model.name), ...model });
  const session = await createSession({
    llm,
    tools: createCoderTools(env, { workdir }),
    systemPrompt: [
      "You are working in a small TypeScript project.",
      "Use bash for inspection, then prefer read/write/edit tools for file changes.",
      "Be concise in your responses.",
    ].join(" "),
    onEvent: createDemoLogger(),
  });

  console.log("\nRunning...\n");
  const result = await session.prompt(userPrompt);

  console.log("\n=== Final response ===");
  console.log(getAssistantText(result).trim() || "(no text)");

  printToolSummary(session.messages());

  console.log(`\nWorkspace on disk: ${hostRoot}`);
}

main().catch((error) => {
  console.error("\nDemo failed:");
  console.error(error);
  process.exitCode = 1;
});
