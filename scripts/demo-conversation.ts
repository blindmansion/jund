import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Bash, ReadWriteFs } from "just-bash";
import { anthropic } from "@ai-sdk/anthropic";
import { createAISDKProvider } from "../src/adapters/ai-sdk.ts";
import { createSession, getAssistantText, type Environment, type Session } from "../src/index.ts";
import {
  createDemoLogger,
  ensureAnthropicKey,
  getLiveModel,
  printToolSummary,
} from "./demo-helpers.ts";

const hostRoot = path.join(process.cwd(), ".tmp", "demo-conversation");
const workdir = "/";

async function seedWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "todo-app",
        version: "0.1.0",
        type: "module",
        scripts: {
          start: "bun src/index.ts",
          test: "bun test",
        },
      },
      null,
      2,
    ) + "\n",
  );

  await writeFile(
    path.join(root, "README.md"),
    ["# Todo App", "", "A simple in-memory todo list for conversation testing.", ""].join("\n"),
  );

  await writeFile(
    path.join(root, "src", "todo.ts"),
    [
      "export interface Todo {",
      "  id: number;",
      "  text: string;",
      "  done: boolean;",
      "}",
      "",
      "let nextId = 1;",
      "const todos: Todo[] = [];",
      "",
      "export function addTodo(text: string): Todo {",
      "  const todo: Todo = { id: nextId++, text, done: false };",
      "  todos.push(todo);",
      "  return todo;",
      "}",
      "",
      "export function listTodos(): Todo[] {",
      "  return [...todos];",
      "}",
      "",
      "export function completeTodo(id: number): Todo | undefined {",
      "  const todo = todos.find((t) => t.id === id);",
      "  if (todo) todo.done = true;",
      "  return todo;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      'import { addTodo, completeTodo, listTodos } from "./todo.ts";',
      "",
      'addTodo("Set up project");',
      'addTodo("Write tests");',
      "completeTodo(1);",
      "",
      "for (const todo of listTodos()) {",
      '  const mark = todo.done ? "x" : " ";',
      "  console.log(`[${mark}] ${todo.id}: ${todo.text}`);",
      "}",
      "",
    ].join("\n"),
  );
}

function createPromptInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
    rl.once("close", () => resolve(null));
  });
}

async function conversationLoop(session: Session, rl: readline.Interface): Promise<void> {
  let turn = 0;

  console.log("\n--- Conversation started (type 'quit' or Ctrl-D to exit) ---\n");

  while (true) {
    const input = await ask(rl, "you> ");
    if (input === null || input.toLowerCase() === "quit" || input.toLowerCase() === "exit") {
      break;
    }
    if (!input) continue;

    turn++;
    console.log();

    try {
      const result = await session.prompt(input);
      const text = getAssistantText(result).trim();

      if (text) {
        console.log(`\nassistant> ${text}\n`);
      } else {
        console.log("\nassistant> (completed with no text)\n");
      }
    } catch (error) {
      console.error(`\n[error on turn ${turn}]`, error instanceof Error ? error.message : error);
      console.log("(session is still alive, you can keep going)\n");
    }
  }
}

async function main(): Promise<void> {
  if (!ensureAnthropicKey()) return;

  console.log("Seeding workspace...");
  await seedWorkspace(hostRoot);

  const fs = new ReadWriteFs({ root: hostRoot });
  const shell = new Bash({ fs, cwd: workdir });
  const env: Environment = { fs, shell };

  const model = getLiveModel();
  const llm = createAISDKProvider({ model: anthropic(model.name), ...model });
  const session = await createSession({
    llm,
    workdir,
    env,
    systemPrompt: [
      "You are pair-programming on a small TypeScript todo app.",
      "The user will ask you to inspect, modify, or extend the code across multiple turns.",
      "Use bash for quick inspection and read/write/edit tools for file work.",
      "Keep responses concise — a few sentences max unless the user asks for detail.",
    ].join(" "),
    onEvent: createDemoLogger(),
  });

  const rl = createPromptInterface();

  try {
    await conversationLoop(session, rl);
  } finally {
    rl.close();
  }

  console.log("\n--- Session summary ---");
  const msgs = session.messages();
  const userTurns = msgs.filter((m) => m.role === "user").length;
  const assistantTurns = msgs.filter((m) => m.role === "assistant").length;
  console.log(`Turns: ${userTurns} user, ${assistantTurns} assistant`);
  printToolSummary(msgs);
  console.log(`Workspace on disk: ${hostRoot}`);
}

main().catch((error) => {
  console.error("\nDemo failed:");
  console.error(error);
  process.exitCode = 1;
});
