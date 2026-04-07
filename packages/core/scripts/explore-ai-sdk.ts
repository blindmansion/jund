/**
 * Sanity-check script to explore the AI SDK's streaming, tool-call, and
 * multi-step shapes. Run with: bun scripts/explore-ai-sdk.ts
 *
 * Exercises the pieces we need for the harness adapter:
 *   1. Basic streaming text
 *   2. Tool definitions via zod + tool() helper
 *   3. Single-step tool call (model calls a tool, we see the shape)
 *   4. Multi-step tool loop (model calls tools, gets results, continues)
 *   5. Stream event shapes (deltas, finish reasons, token usage)
 */

import { streamText, tool, stepCountIs, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const model = anthropic("claude-sonnet-4-20250514");

const sep = (title: string) => console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);

// ---------------------------------------------------------------------------
// 1. Basic streaming text
// ---------------------------------------------------------------------------
async function basicStreaming() {
  sep("1. Basic Streaming Text");

  const result = streamText({
    model,
    messages: [{ role: "user", content: "Say hello in exactly 5 words." }],
  });

  console.log("\n--- Stream parts ---");
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    } else if (part.type === "finish-step") {
      console.log(
        `\n[finish-step] finishReason=${part.finishReason} usage=${JSON.stringify(part.usage)}`,
      );
    } else if (part.type === "finish") {
      console.log(
        `[finish] finishReason=${part.finishReason} totalUsage=${JSON.stringify(part.totalUsage)}`,
      );
    } else if (
      part.type === "start" ||
      part.type === "start-step" ||
      part.type === "text-start" ||
      part.type === "text-end"
    ) {
      // skip noise
    } else {
      console.log(`[${part.type}]`, JSON.stringify(part, null, 2).slice(0, 300));
    }
  }

  const response = await result.response;
  console.log("\n--- Final metadata ---");
  console.log("response.id:", response.id);
  console.log("response.modelId:", response.modelId);
}

// ---------------------------------------------------------------------------
// 2. Tool definitions and single-step tool call
// ---------------------------------------------------------------------------
async function singleToolCall() {
  sep("2. Single-Step Tool Call");

  const tools = {
    readFile: tool({
      description: "Read the contents of a file at the given path.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file"),
      }),
    }),
    listDir: tool({
      description: "List files in a directory.",
      inputSchema: z.object({
        path: z.string().describe("Directory path"),
      }),
    }),
  };

  const result = streamText({
    model,
    messages: [
      { role: "user", content: "Read the file at /tmp/test.txt and tell me what's in it." },
    ],
    tools,
    stopWhen: stepCountIs(1),
  });

  console.log("\n--- Stream parts (tool call expected) ---");
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        process.stdout.write(part.text);
        break;
      case "tool-call":
        console.log("\n[tool-call]", JSON.stringify(part, null, 2));
        break;
      case "tool-result":
        console.log("[tool-result]", JSON.stringify(part, null, 2));
        break;
      case "finish-step":
        console.log(
          `[finish-step] finishReason=${part.finishReason} usage=${JSON.stringify(part.usage)}`,
        );
        break;
      case "finish":
        console.log(
          `[finish] finishReason=${part.finishReason} totalUsage=${JSON.stringify(part.totalUsage)}`,
        );
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Multi-step tool loop (maxSteps > 1, with execute functions)
// ---------------------------------------------------------------------------
async function multiStepToolLoop() {
  sep("3. Multi-Step Tool Loop (with execute)");

  const tools = {
    readFile: tool({
      description: "Read the contents of a file at the given path.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file"),
      }),
      execute: async ({ path }) => {
        console.log(`  [execute readFile] path=${path}`);
        return `Contents of ${path}:\nHello from the mock filesystem!\nLine 2\nLine 3`;
      },
    }),
    listDir: tool({
      description: "List files in a directory.",
      inputSchema: z.object({
        path: z.string().describe("Directory path"),
      }),
      execute: async ({ path }) => {
        console.log(`  [execute listDir] path=${path}`);
        return `file1.txt\nfile2.ts\nREADME.md`;
      },
    }),
  };

  const result = streamText({
    model,
    messages: [
      {
        role: "user",
        content:
          "List the files in /tmp/project, then read file1.txt from that directory. Summarize both results in one sentence.",
      },
    ],
    tools,
    stopWhen: stepCountIs(5),
  });

  console.log("\n--- Stream (multi-step with tool execution) ---");
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        process.stdout.write(part.text);
        break;
      case "tool-call":
        console.log(`\n[tool-call] ${part.toolName}(${JSON.stringify(part.input)})`);
        break;
      case "tool-result":
        console.log(
          `[tool-result] ${part.toolName} → ${JSON.stringify(part.output).slice(0, 100)}`,
        );
        break;
      case "finish-step":
        console.log(
          `[finish-step] reason=${part.finishReason} usage=${JSON.stringify(part.usage)}`,
        );
        break;
      case "finish":
        console.log(
          `\n[finish] reason=${part.finishReason} totalUsage=${JSON.stringify(part.totalUsage)}`,
        );
        break;
      default:
        break;
    }
  }

  const steps = await result.steps;
  console.log("\n--- steps[] shape ---");
  for (const [i, step] of steps.entries()) {
    console.log(
      `  step[${i}]: finishReason=${step.finishReason} toolCalls=${step.toolCalls.length} toolResults=${step.toolResults.length} text="${step.text.slice(0, 80)}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Message round-trip shapes (what messages look like after tool calls)
// ---------------------------------------------------------------------------
async function messageShapes() {
  sep("4. Message Shapes (ModelMessage round-trip)");

  const messages: ModelMessage[] = [
    { role: "user", content: "What is 2 + 2?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me calculate that." },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "calculator",
          input: { expression: "2 + 2" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "calculator",
          output: { type: "text", value: "4" },
        },
      ],
    },
  ];

  console.log("\n--- ModelMessage[] we send ---");
  for (const msg of messages) {
    console.log(`  role=${msg.role}`, JSON.stringify(msg.content).slice(0, 200));
  }

  const result = streamText({
    model,
    messages,
  });

  console.log("\n--- Model response ---");
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    }
  }

  const response = await result.response;
  console.log("\n\nfinishReason:", await result.finishReason);
  console.log("response messages:", JSON.stringify(response.messages, null, 2).slice(0, 500));
}

// ---------------------------------------------------------------------------
// 5. Reasoning / extended thinking (if supported)
// ---------------------------------------------------------------------------
async function reasoningStream() {
  sep("5. Reasoning / Extended Thinking");

  try {
    const result = streamText({
      model: anthropic("claude-sonnet-4-20250514"),
      messages: [{ role: "user", content: "What is 127 * 343? Think step by step." }],
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 2048 },
        },
      },
    });

    console.log("\n--- Stream (with reasoning) ---");
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta":
          console.log(`[reasoning-delta] "${part.text.slice(0, 100)}..."`);
          break;
        case "text-delta":
          process.stdout.write(part.text);
          break;
        case "finish-step":
          console.log(`\n[finish-step] reason=${part.finishReason}`);
          break;
        default:
          break;
      }
    }

    const response = await result.response;
    console.log("response.modelId:", response.modelId);
  } catch (e) {
    console.log("Reasoning not supported or failed:", (e as Error).message.slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------
async function main() {
  console.log("AI SDK Exploration Script");
  console.log("Model: claude-sonnet-4-20250514 via @ai-sdk/anthropic");

  await basicStreaming();
  await singleToolCall();
  await multiStepToolLoop();
  await messageShapes();
  await reasoningStream();

  console.log("\n\nDone.");
}

main().catch(console.error);
