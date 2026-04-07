// ── Host-provided environment interfaces ─────────────────────────────────────
// The built-in file tools all operate on the same minimal filesystem shape.

export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  readdir(path: string): Promise<string[]>;
}

// Duck-types with Bash.exec()
export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  stdin?: string;
}

export interface ShellOps {
  exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

// ── Environment bundle ───────────────────────────────────────────────────────

export interface Environment {
  fs: FileSystem;
  shell: ShellOps;
}

// ── Message model ───────────────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  model: string;
}

export type Message = UserMessage | AssistantMessage;

export interface UserMessage {
  id: string;
  role: "user";
  parts: UserPart[];
  model: ModelRef;
  agent: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  parts: AssistantPart[];
  agent: string;
  model: ModelRef;
  tokens?: { input: number; output: number };
  finishReason?: string;
  error?: AgentError;
}

export type UserPart = TextPart | FilePart;
export type AssistantPart = TextPart | ToolCallPart | ReasoningPart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface FilePart {
  type: "file";
  path: string;
  mime: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export type ToolCallState =
  | { status: "pending" }
  | { status: "running"; startedAt: number }
  | { status: "completed"; output: string; duration: number }
  | { status: "error"; error: string; duration: number };

export interface ToolCallPart {
  type: "tool";
  id: string;
  tool: string;
  input: unknown;
  state: ToolCallState;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryable = retryable;
  }
}
