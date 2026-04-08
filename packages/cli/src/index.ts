import path from "node:path";
import process from "node:process";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import {
  box,
  cancel as cancelPrompt,
  group,
  intro,
  isCancel,
  log,
  outro,
  path as pathPrompt,
  select,
  spinner,
  taskLog,
  tasks,
  text,
} from "@clack/prompts";
import { createAISDKProvider } from "@jund/core/ai-sdk";
import {
  createSession,
  getAssistantText,
  type AgentEvent,
  type Environment,
  type Session,
} from "@jund/core";
import { Bash, ReadWriteFs } from "just-bash";

const DEFAULT_PROVIDER = "anthropic" as const;
const DEFAULT_ANTHROPIC_MODEL = process.env.LIVE_LLM_MODEL ?? "claude-sonnet-4-5";
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";
const DEFAULT_WORKDIR = "/";

type ProviderId = "anthropic" | "openai";

class PromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
  }
}

type CommandResult = "handled" | "exit";
type TurnLog = ReturnType<typeof taskLog>;
type TurnLogGroup = ReturnType<TurnLog["group"]>;
type TurnSummary = {
  tools: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
};

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new PromptCancelledError();
  }
  return value as T;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

function getObjectField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function formatToolDetail(tool: string, input: unknown): string {
  switch (tool) {
    case "bash":
      return truncate(getObjectField(input, "command") ?? "shell command", 96);
    case "read":
    case "write":
    case "edit":
      return truncate(getObjectField(input, "path") ?? "file", 96);
    case "task":
      return truncate(getObjectField(input, "prompt") ?? "subagent task", 96);
    default:
      return truncate(JSON.stringify(input) ?? "", 96);
  }
}

function formatToolOutput(chunk: string): string {
  const line = chunk
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  return truncate(line ?? "", 100);
}

function renderSessionBox(options: {
  workspace: string;
  provider: ProviderId;
  modelName: string;
  sessionId: string;
  turnCount?: number;
  lastTurn?: TurnSummary;
}) {
  const lines = [
    `Workspace  ${options.workspace}`,
    `Provider   ${options.provider}`,
    `Model      ${options.modelName}`,
    `Session    ${options.sessionId}`,
  ];

  if (options.turnCount != null) {
    lines.push(`Turns      ${options.turnCount}`);
  }

  if (options.lastTurn) {
    lines.push(
      `Last turn  ${options.lastTurn.tools} tools | ${options.lastTurn.steps} steps | ${options.lastTurn.inputTokens} in / ${options.lastTurn.outputTokens} out`,
    );
  }

  lines.push("", "Commands   /help  /status  /exit");

  box(lines.join("\n"), "@jund/cli", {
    rounded: true,
    width: "auto",
    withGuide: false,
  });
}

function renderHelpBox() {
  box(
    [
      "/help    Show available commands",
      "/status  Show current session details",
      "/exit    Close the session",
    ].join("\n"),
    "Commands",
    { rounded: true, width: "auto", withGuide: false },
  );
}

async function promptForSetup(initialArgInput: string): Promise<{
  workspace: string;
  provider: ProviderId;
  modelName: string;
  initialTask: string;
}> {
  const workspace = path.resolve(
    unwrapPrompt(
      await pathPrompt({
        message: "Workspace",
        directory: true,
        initialValue: process.cwd(),
        withGuide: false,
      }),
    ),
  );

  const provider = unwrapPrompt(
    await select({
      message: "Provider",
      initialValue: DEFAULT_PROVIDER,
      options: [
        { value: "anthropic", label: "Anthropic" },
        { value: "openai", label: "OpenAI" },
      ],
      withGuide: false,
    }),
  ) as ProviderId;

  const defaultModel = provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
  const modelName = await promptForInput("Model", defaultModel, defaultModel);
  const initialTask = initialArgInput
    ? initialArgInput
    : await promptForInput("Task", "Inspect the repo and suggest the next change");

  return { workspace, provider, modelName, initialTask };
}

async function promptForInput(message: string, placeholder: string, fallback = ""): Promise<string> {
  const value = unwrapPrompt(
    await text({
      message,
      placeholder,
      withGuide: false,
    }),
  );
  const trimmed = value.trim();
  return trimmed || fallback;
}

function handleSlashCommand(
  input: string,
  session: Session,
  workspace: string,
  provider: ProviderId,
  modelName: string,
): CommandResult {
  if (input === "/exit" || input === "/quit") {
    return "exit";
  }

  if (input === "/status") {
    const messages = session.messages();
    const turnCount = messages.filter((message) => message.role === "user").length;
    renderSessionBox({ workspace, provider, modelName, sessionId: session.id, turnCount });
    return "handled";
  }

  if (input === "/help") {
    renderHelpBox();
    return "handled";
  }

  log.warning(`Unknown command: ${input}`);
  return "handled";
}

function createTurnReporter(turnNumber: number, input: string) {
  const phase = spinner({ indicator: "timer" });
  const timeline = taskLog({
    title: `Turn ${turnNumber}: ${truncate(input, 72)}`,
    limit: 8,
    spacing: 0,
    retainLog: true,
  });
  const eventStream = timeline.group("Event stream");

  let activeTool:
    | {
        tool: string;
        group: TurnLogGroup;
        lastOutput: string;
      }
    | undefined;

  let hasText = false;
  let sawTool = false;
  let stepCount = 0;
  let toolCallCount = 0;
  let latestToolPreview = "";
  let latestTokenSummary = "";
  let finalInputTokens = 0;
  let finalOutputTokens = 0;

  const shouldStreamToolEvent = (tool: string) => tool === "bash" || tool === "task";
  const shouldRetainToolRow = (tool: string) => tool !== "read";

  const setPhase = (message: string) => {
    const parts = [message];
    if (latestToolPreview) {
      parts.push(`latest ${latestToolPreview}`);
    }
    if (latestTokenSummary) {
      parts.push(latestTokenSummary);
    }
    phase.message(parts.join(" | "));
  };

  return {
    start() {
      phase.start("Planning");
      timeline.message(`Prompt: ${truncate(input, 120)}`);
    },
    onEvent(event: AgentEvent) {
      switch (event.type) {
        case "turn.start":
          setPhase("Planning");
          break;
        case "text.delta":
          if (!hasText) {
            hasText = true;
            eventStream.message("Assistant is drafting a response");
            setPhase("Drafting response");
          }
          break;
        case "tool.start": {
          sawTool = true;
          toolCallCount += 1;
          const detail = formatToolDetail(event.tool, event.input);
          const label = detail ? `${event.tool}: ${detail}` : event.tool;

          activeTool = {
            tool: event.tool,
            group: shouldRetainToolRow(event.tool) ? timeline.group(label) : eventStream,
            lastOutput: "",
          };

          if (shouldStreamToolEvent(event.tool)) {
            eventStream.message(`Started ${label}`);
          }
          latestToolPreview = "";
          setPhase(`Running ${label}`);
          break;
        }
        case "tool.output": {
          const output = formatToolOutput(event.chunk);
          if (!output) {
            break;
          }

          if (!activeTool) {
            latestToolPreview = output;
            setPhase("Streaming tool output");
            break;
          }

          if (output === activeTool.lastOutput) {
            break;
          }

          activeTool.lastOutput = output;
          latestToolPreview = `${activeTool.tool}: ${output}`;
          setPhase(`Running ${activeTool.tool}`);
          break;
        }
        case "tool.end":
          if (activeTool && shouldRetainToolRow(event.tool)) {
            activeTool.group.success(event.result.title ?? `${event.tool} complete`);
          }
          if (shouldStreamToolEvent(event.tool)) {
            eventStream.message(`Finished ${event.tool}`);
          }
          activeTool = undefined;
          latestToolPreview = "";
          setPhase("Thinking");
          break;
        case "retry":
          eventStream.message(
            `Retry ${event.attempt}/${event.maxAttempts} in ${formatSeconds(event.delayMs)}: ${truncate(event.error, 120)}`,
          );
          setPhase(`Retry ${event.attempt}/${event.maxAttempts}`);
          break;
        case "compaction":
          eventStream.message(`Compacted context ${event.before} -> ${event.after} tokens`);
          setPhase("Compacting context");
          break;
        case "step.finish":
          stepCount += 1;
          finalInputTokens = event.tokens.input;
          finalOutputTokens = event.tokens.output;
          latestTokenSummary = `${finalInputTokens} in / ${finalOutputTokens} out`;
          setPhase("Finalizing response");
          break;
        case "error":
          eventStream.message(`Agent error: ${event.error.message}`);
          setPhase("Error");
          break;
        default:
          break;
      }
    },
    finish(output: string) {
      phase.stop(`Turn ${turnNumber} complete`);
      const summaryParts = [`${toolCallCount} tool${toolCallCount === 1 ? "" : "s"}`];
      if (stepCount > 0) {
        summaryParts.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`);
      }
      if (finalInputTokens > 0 || finalOutputTokens > 0) {
        summaryParts.push(`${finalInputTokens} in / ${finalOutputTokens} out`);
      }
      timeline.message(`Summary: ${summaryParts.join(" | ")}`);
      if (stepCount > 0) {
        eventStream.success(`Completed ${stepCount} model step${stepCount === 1 ? "" : "s"}`);
      } else if (sawTool || hasText) {
        eventStream.success("Turn events captured");
      } else {
        eventStream.success("No streamed events captured");
      }
      timeline.success(`Turn ${turnNumber} complete`, { showLog: true });
      box(output || "(no text)", `Assistant ${turnNumber}`, {
        rounded: true,
        width: "auto",
        withGuide: false,
      });

      return {
        tools: toolCallCount,
        steps: stepCount,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
      } satisfies TurnSummary;
    },
    fail(error: unknown) {
      const message = formatError(error);

      if (activeTool) {
        activeTool.group.error(message);
        activeTool = undefined;
      }

      eventStream.error("Turn failed");
      phase.error(`Turn ${turnNumber} failed`);
      timeline.error(`Turn ${turnNumber} failed`, { showLog: true });
      log.error(message);

      return {
        tools: toolCallCount,
        steps: stepCount,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
      } satisfies TurnSummary;
    },
  };
}

export async function main(): Promise<void> {
  intro("@jund/cli", { withGuide: false });

  try {
    const initialArgInput = process.argv.slice(2).join(" ").trim();
    const setup = await promptForSetup(initialArgInput);

    if (setup.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
      cancelPrompt("Set ANTHROPIC_API_KEY before running the Anthropic CLI flow.", { withGuide: false });
      process.exitCode = 1;
      return;
    }

    if (setup.provider === "openai" && !process.env.OPENAI_API_KEY) {
      cancelPrompt("Set OPENAI_API_KEY before running the OpenAI CLI flow.", { withGuide: false });
      process.exitCode = 1;
      return;
    }

    let env!: Environment;
    let session!: Session;
    let activeTurnReporter: ReturnType<typeof createTurnReporter> | undefined;

    await tasks([
      {
        title: "Prepare workspace host",
        async task(message) {
          message(setup.workspace);

          const fs = new ReadWriteFs({ root: setup.workspace });
          const shell = new Bash({ fs, cwd: DEFAULT_WORKDIR });
          env = { fs, shell };

          return "Workspace host ready";
        },
      },
      {
        title: "Create agent session",
        async task(message) {
          message(`${setup.provider} ${setup.modelName}`);

          const providerModel =
            setup.provider === "anthropic"
              ? anthropic(setup.modelName)
              : openai(setup.modelName);

          const llm = createAISDKProvider({
            model: providerModel,
            id: `${setup.provider}:${setup.modelName}`,
            name: setup.modelName,
            contextLimit: 200_000,
            outputLimit: 16_384,
            capabilities: { reasoning: true, toolCalls: true, images: false },
          });

          session = await createSession({
            llm,
            workdir: DEFAULT_WORKDIR,
            env,
            toolExecution: "sequential",
            systemPrompt: [
              "You are operating through the jund headless coding harness.",
              "Inspect the workspace before editing.",
              "Use bash for quick inspection and prefer read/write/edit for file work.",
              "Keep responses concise and factual.",
            ].join(" "),
            onEvent(event) {
              activeTurnReporter?.onEvent(event);
            },
          });

          return session.id;
        },
      },
    ], { withGuide: false });

    renderSessionBox({
      workspace: setup.workspace,
      provider: setup.provider,
      modelName: setup.modelName,
      sessionId: session.id,
    });

    let turnNumber = 1;
    let input = setup.initialTask;

    while (true) {
      if (!input) {
        input = await promptForInput("You", "Ask the agent to inspect or change code");
        continue;
      }

      const trimmed = input.trim();
      if (!trimmed) {
        input = "";
        continue;
      }

      if (trimmed.startsWith("/")) {
        const result = handleSlashCommand(trimmed, session, setup.workspace, setup.provider, setup.modelName);
        if (result === "exit") {
          break;
        }
      } else {
        const reporter = createTurnReporter(turnNumber, trimmed);
        activeTurnReporter = reporter;
        reporter.start();

        try {
          const reply = await session.prompt(trimmed);
          reporter.finish(getAssistantText(reply).trim());
        } catch (error) {
          reporter.fail(error);
        } finally {
          activeTurnReporter = undefined;
        }

        turnNumber += 1;
      }

      input = await promptForInput("You", "Follow up, /status for tokens/tools, or /exit");
    }

    outro(`Session ${session.id} closed.`, { withGuide: false });
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      cancelPrompt("Cancelled.", { withGuide: false });
      return;
    }

    cancelPrompt(formatError(error), { withGuide: false });
    process.exitCode = 1;
  }
}
