import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Bash, ReadWriteFs } from "just-bash";
import { anthropic } from "@ai-sdk/anthropic";
import { createAISDKProvider } from "../src/adapters/ai-sdk.ts";
import { createSession, getAssistantText, type Environment } from "../src/index.ts";
import {
  createDemoLogger,
  ensureAnthropicKey,
  getLiveModel,
  printToolSummary,
} from "./demo-helpers.ts";

const hostRoot = path.join(process.cwd(), ".tmp", "demo-just-bash-minimal");
const workdir = "/";

async function seedWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "tiny-greeter",
        version: "0.1.0",
        type: "module",
        scripts: {
          start: "bun src/index.ts",
        },
      },
      null,
      2,
    ) + "\n",
  );

  await writeFile(
    path.join(root, "README.md"),
    [
      "# Tiny Greeter",
      "",
      "A tiny demo app for the minimal just-bash environment example.",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(root, "src", "index.ts"),
    ['console.log("hello from tiny greeter");', ""].join("\n"),
  );
}

async function main(): Promise<void> {
  if (!ensureAnthropicKey()) {
    return;
  }

  await seedWorkspace(hostRoot);

  const fs = new ReadWriteFs({ root: hostRoot });
  const shell = new Bash({ fs, cwd: workdir });

  // This is the minimal shape now: just-bash already matches closely enough
  // that we can hand its fs and exec-bearing shell object straight to jund.
  const env: Environment = {
    fs,
    shell,
  };

  const model = getLiveModel();
  const llm = createAISDKProvider({ model: anthropic(model.name), ...model });
  const session = await createSession({
    llm,
    workdir,
    env,
    systemPrompt:
      "You are demoing minimal just-bash host wiring. Use bash for quick inspection, then prefer read/write/edit tools for file work.",
    onEvent: createDemoLogger(),
  });

  const result = await session.prompt(
    [
      "Inspect the project with bash first.",
      "Then create NOTES.md with two short bullets describing the project and one bullet suggesting a next step.",
      "Finish with a one-sentence summary.",
    ].join(" "),
  );

  console.log("\n=== Final assistant summary ===");
  console.log(getAssistantText(result).trim() || "(no text)");

  console.log("\n=== NOTES.md ===");
  console.log(await readFile(path.join(hostRoot, "NOTES.md"), "utf8"));

  printToolSummary(session.messages());
}

main().catch((error) => {
  console.error("\nDemo failed:");
  console.error(error);
  process.exitCode = 1;
});
