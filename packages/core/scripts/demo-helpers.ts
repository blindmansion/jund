import type { EventHandler, Message, ModelInfo } from "../src/index.ts";

const LIVE_MODEL_ID = process.env.LIVE_LLM_MODEL ?? "claude-sonnet-4-20250514";

export function getLiveModel(): ModelInfo {
  return {
    id: `anthropic:${LIVE_MODEL_ID}`,
    name: LIVE_MODEL_ID,
    contextLimit: 200_000,
    outputLimit: 16_384,
    capabilities: { reasoning: true, toolCalls: true, images: false },
  };
}

export function ensureAnthropicKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) {
    return true;
  }

  console.log("These demos use a live Anthropic model.");
  console.log("Set ANTHROPIC_API_KEY before running them.");
  return false;
}

function textFromMessage(message: Message): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function truncate(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

export function createDemoLogger(): EventHandler {
  let assistantOpen = false;
  let textOpen = false;

  function ensureAssistantHeader() {
    if (!assistantOpen) {
      console.log("\n[assistant]");
      assistantOpen = true;
    }
  }

  function finishTextLine() {
    if (textOpen) {
      process.stdout.write("\n");
      textOpen = false;
    }
  }

  return (event) => {
    switch (event.type) {
      case "message.created":
        if (event.message.role === "user") {
          finishTextLine();
          assistantOpen = false;
          console.log(`\n[user] ${textFromMessage(event.message).trim()}`);
        }
        break;
      case "text.delta":
        ensureAssistantHeader();
        process.stdout.write(event.text);
        textOpen = true;
        break;
      case "reasoning.delta":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [reasoning] ${truncate(event.text)}`);
        break;
      case "tool.start":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [tool:${event.tool}] start ${truncate(JSON.stringify(event.input))}`);
        break;
      case "tool.end":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [tool:${event.tool}] ${event.result.title}`);
        break;
      case "tool.output":
        break;
      case "step.finish":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [tokens] in=${event.tokens.input} out=${event.tokens.output}`);
        break;
      case "retry":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [retry] attempt ${event.attempt}/${event.maxAttempts}: ${event.error}`);
        break;
      case "compaction":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [compaction] ${event.before} -> ${event.after}`);
        break;
      case "error":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [error] ${event.error.message}`);
        assistantOpen = false;
        break;
      case "done":
        ensureAssistantHeader();
        finishTextLine();
        console.log(`  [finish] ${event.message.finishReason ?? "unknown"}`);
        assistantOpen = false;
        break;
      case "tools.changed":
        break;
      default:
        break;
    }
  };
}

export function printToolSummary(messages: Message[]): void {
  const counts = new Map<string, number>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue;
      }
      counts.set(part.tool, (counts.get(part.tool) ?? 0) + 1);
    }
  }

  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolName, count]) => `${toolName}=${count}`)
    .join(", ");

  console.log(`\nTool usage: ${summary || "(none)"}`);
}
