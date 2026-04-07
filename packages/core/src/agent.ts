import { DEFAULT_SYSTEM_PROMPT } from "./prompt.ts";

// ── Agent configuration ─────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  description?: string;
  mode: "primary" | "subagent";
  tools?: string[];
  deniedTools?: string[];
  maxSteps?: number;
  temperature?: number;
}

// ── Built-in agents ─────────────────────────────────────────────────────────

export const CODER_AGENT: AgentConfig = {
  name: "coder",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  mode: "primary",
};

export const EXPLORER_AGENT: AgentConfig = {
  name: "explorer",
  systemPrompt: [
    "You are a read-only code exploration assistant.",
    "You can read files and inspect directories, but you cannot modify files or run shell commands.",
    "Answer the user's question about the codebase thoroughly and concisely.",
  ].join("\n"),
  description: "Read-only subagent for codebase exploration",
  mode: "subagent",
  tools: ["read"],
};
