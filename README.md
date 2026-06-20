# jund

Platform-agnostic coding agent primitive inspired by [opencode](https://github.com/sst/opencode) and [pi](https://github.com/badlogic/pi-mono).

jund accepts a `FileSystem` interface and an `exec` function instead of
touching the host directly, so the same agent session works against a real
disk, an in-memory FS, or a virtual sandbox like
[just-bash](https://github.com/vercel-labs/just-bash). The only runtime
dependency is zod, so it runs anywhere (Node, Bun, Deno, edge workers,
the browser).

> **Status:** Experimental - the public API is not stable and may change without notice.

## Install

```bash
npm install @jund/core
```

Provider adapters are optional:

```bash
npm install ai              # for @jund/core/ai-sdk
npm install @openrouter/sdk  # for @jund/core/openrouter-sdk
npm install @tanstack/ai     # for @jund/core/tanstack-ai
```

## Quick start

```typescript
import Database from "better-sqlite3";
import { Bash, ReadWriteFs } from "just-bash";
import { anthropic } from "@ai-sdk/anthropic";
import { createAISDKProvider } from "@jund/core/ai-sdk";
import {
  createSession,
  createCoderTools,
  getAssistantText,
  BetterSqlite3Storage,
} from "@jund/core";

const fs = new ReadWriteFs({ root: "./my-project" });
const shell = new Bash({ fs, cwd: "/" });

const storage = new BetterSqlite3Storage(new Database("sessions.db"));

const llm = createAISDKProvider({
  model: anthropic("claude-opus-4-6"),
  id: "claude-opus-4-6",
  contextLimit: 200_000,
  outputLimit: 64_000,
  capabilities: { reasoning: true, toolCalls: true, images: true },
});

const session = await createSession({
  llm,
  // File/shell tools are produced from your environment and passed in.
  tools: createCoderTools({ fs, shell }, { workdir: "/" }),
  storage,
  onEvent: (event) => console.log(event.type),
});

const reply = await session.prompt("Add a health-check endpoint to the server.");
console.log(getAssistantText(reply));
```

## Entry points

| Import                      | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `@jund/core`                | Core session, tools, types, events, context pipeline |
| `@jund/core/ai-sdk`         | Adapter for the Vercel AI SDK (`ai`)                 |
| `@jund/core/openrouter-sdk` | Adapter for `@openrouter/sdk`                        |
| `@jund/core/tanstack-ai`    | Adapter for `@tanstack/ai`                           |

## Core API

### `createSession(options): Promise<Session>`

Creates a stateful agent session. Key options:

| Option          | Type                            | Description                                        |
| --------------- | ------------------------------- | -------------------------------------------------- |
| `llm`           | `LLMProviderWithModel`          | LLM backend + model metadata (use an adapter)      |
| `tools`         | `ToolDef[]`                     | Tools available to the agent (e.g. `createCoderTools`) |
| `systemPrompt`  | `string`                        | Prepended to the default system prompt             |
| `toolExecution` | `"parallel" \| "sequential"`    | How tool calls in a single step run                |
| `onEvent`       | `EventHandler`                  | Stream of `AgentEvent`s (deltas, tool calls, etc.) |
| `compaction`    | `false \| CompactionOptions`    | Context-window compaction strategy                 |
| `storage`       | `SessionStorageDriver`          | Persist turns and messages                         |
| `retry`         | `{ maxAttempts?, maxDelayMs? }` | LLM retry policy                                   |

Lifecycle hooks: `beforeInput`, `beforeToolCall`, `afterToolCall`, `beforeLLMCall`, `beforePrompt`, `beforeCompaction`, `beforeBranch`, `transformContext`.

### `Session`

```typescript
interface Session {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly branchedFromMessageId: string | undefined;
  readonly model: ModelInfo;
  readonly isStreaming: boolean;
  prompt(input: string | UserPart[]): Promise<AssistantMessage>;
  cancel(): void;
  messages(): Message[];
  branchFrom(messageId: string, options?: BranchOptions): Promise<Session>;
  addTool(tool: ToolDef): void;
  removeTool(id: string): void;
  setTools(tools: ToolDef[]): void;
  compact(): Promise<boolean>;
  setLLM(llm: LLMProviderWithModel): Promise<void>;
  // + setters for every lifecycle hook
}
```

### `resumeSession(sessionId, options): Promise<Session>`

Resumes an existing persisted session. Throws if the session does not exist.
Runtime dependencies (`llm`, `storage`) are required; `defaultAgent` defaults
from the stored session state. Re-supply the toolset (e.g. `createCoderTools`)
the same way you did when creating the session.

```typescript
const session = await resumeSession("session-123", {
  llm,
  storage,
  tools: createCoderTools({ fs, shell }, { workdir: "/" }),
});
```

### Session discovery

Query stored sessions without creating a live `Session`:

```typescript
const all = await listSessions(storage);
const branches = await listBranches(storage, parentSessionId);
const info = await getSessionInfo(storage, sessionId);
```

Each returns `SessionInfo` objects with `id`, `parentSessionId`,
`branchedFromMessageId`, `model`, `agent`, and timestamps.

### Tools

Filesystem and shell access are provided as ordinary tools rather than baked
into the session. Build them from an `Environment` with `createCoderTools`, or
use the individual factories for finer control:

| Factory                                   | Description                            |
| ----------------------------------------- | -------------------------------------- |
| `createCoderTools(env, { workdir })`      | Read/write/edit/bash bound to `env`    |
| `createReadTool(env, { workdir })`        | Read file contents                     |
| `createWriteTool(env, { workdir })`       | Write / create files                   |
| `createEditTool(env, { workdir })`        | Apply targeted edits to existing files |
| `createBashTool(env, { workdir })`        | Execute shell commands                 |

```typescript
import { createCoderTools } from "@jund/core";

const tools = createCoderTools({ fs, shell }, { workdir: "/" });
const session = await createSession({ llm, tools });
```

`taskTool` (spawn sub-agent sessions) is the only tool the session installs
automatically for primary agents. Pass extra tools via `tools`, or replace the
whole set at runtime with `setTools`. Tools that mutate state (e.g. `write`,
`edit`) declare a `mutationKey`; the runtime serializes calls sharing a key so
concurrent writes to the same file can't race.

## LLM provider adapters

Each adapter exports a `create*Provider(options): LLMProviderWithModel` factory plus lower-level conversion helpers.

Each adapter factory accepts model metadata alongside the provider-specific
model and returns a `LLMProviderWithModel` — pass it straight to `createSession`:

```typescript
// Vercel AI SDK
import { createAISDKProvider } from "@jund/core/ai-sdk";
const llm = createAISDKProvider({
  model: anthropic("claude-opus-4-6"),
  id: "claude-opus-4-6",
  contextLimit: 200_000,
  outputLimit: 64_000,
  capabilities: { reasoning: true, toolCalls: true, images: true },
});

// OpenRouter
import { createOpenRouterProvider } from "@jund/core/openrouter-sdk";
const llm = createOpenRouterProvider({
  client: openRouterClient,
  model: "anthropic/claude-opus-4-6",
  id: "claude-opus-4-6",
  contextLimit: 200_000,
  outputLimit: 64_000,
  capabilities: { reasoning: true, toolCalls: true, images: true },
});

// TanStack AI
import { createTanStackTextProvider } from "@jund/core/tanstack-ai";
const llm = createTanStackTextProvider({
  adapter: myAdapter,
  id: "claude-opus-4-6",
  contextLimit: 128_000,
  outputLimit: 32_000,
  capabilities: { reasoning: false, toolCalls: true, images: false },
});
```

## Environment

Tools interact with the host through the `Environment` interface:

```typescript
interface Environment {
  fs: FileSystem; // readFile, writeFile, mkdir, exists, stat, readdir
  shell: ShellOps; // exec(command, options?) → { stdout, stderr, exitCode }
}
```

## Events

Subscribe via `onEvent` to receive a stream of typed `AgentEvent`s:

`turn.start`, `turn.end`, `message.created`, `text.delta`, `reasoning.delta`, `tool.start`, `tool.update`, `tool.complete`, `tool.error`, `step.finish`, `compaction`, `retry`, `tools.changed`, `error`, `done`.

## Context compaction

When conversation history approaches the model's context limit, jund automatically summarises older messages. Configure the threshold, strategy, or disable entirely:

```typescript
createSession({
  // ...
  compaction: { threshold: 0.8, strategy: myStrategy },
  // or: compaction: false,
});
```

You can also trigger compaction manually at any time (e.g. from a UI button):

```typescript
const didCompact = await session.compact();
```

Returns `true` if history was compacted, `false` if compaction is disabled or was cancelled by the `beforeCompaction` hook.

## Persistence

Pass any `SessionStorageDriver` as `storage` - `createSession` handles the
rest internally (see the quick start above). Five drivers ship out of the box:

| Driver                       | Backend                           |
| ---------------------------- | --------------------------------- |
| `MemoryStorage`              | In-memory (testing / ephemeral)   |
| `BetterSqlite3Storage`       | `better-sqlite3` (Node)           |
| `BunSqliteStorage`           | `bun:sqlite` (Bun)                |
| `DurableObjectSqliteStorage` | Cloudflare Durable Objects SQLite |
| `PgStorage`                  | PostgreSQL via `pg`               |

Implement `SessionStorageDriver` to bring your own backend.

## Resume and branching

### Resuming a session

Use `resumeSession` to pick up where a previous session left off. The session
must already exist in storage:

```typescript
import { resumeSession } from "@jund/core";

const session = await resumeSession("session-123", {
  llm,
  storage,
  tools: createCoderTools({ fs, shell }, { workdir: "/" }),
  // defaultAgent defaults from stored session
});

// Conversation history is restored automatically
const reply = await session.prompt("Continue where we left off.");
```

`createSession` with an explicit `sessionId` will throw if a session with that
ID already exists - use `resumeSession` when you intend to continue an existing
conversation.

### Branching

Create an alternate conversation timeline from any message:

```typescript
const branch = await session.branchFrom(messageId);
// branch.parentId === session.id
// branch.messages() contains history up to and including messageId

const reply = await branch.prompt("Try a different approach.");
```

Branches are independent sessions - prompting the parent or child does not
affect the other. Branch metadata is accessible via `session.parentId` and
`session.branchedFromMessageId`.

### Discovering sessions and branches

```typescript
import { listSessions, listBranches, getSessionInfo } from "@jund/core";

const all = await listSessions(storage);
const branches = await listBranches(storage, session.id);
const info = await getSessionInfo(storage, "session-123");
```

## Lower-level primitives

For custom orchestration loops without the full `Session`:

- **`callLLM(options)`** - stream a single LLM call with retry.
- **`processTurn(options)`** - one model step with tool execution.
- **`buildSystemPrompt(options)`** - assemble the system prompt.
- **`ToolRegistry`** - manage tool definitions.
- **`estimateTokens`** / **`shouldCompact`** / **`runContextPipeline`** - context utilities.

## License

MIT
