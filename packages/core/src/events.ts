import type { AgentError, AssistantMessage, Message } from "./types.ts";
import type { ToolResult } from "./tool/types.ts";

// ── Agent events ────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "turn.start"; sessionId: string; messageId: string }
  | { type: "turn.end"; sessionId: string; status: "completed" | "failed" }
  | { type: "message.created"; message: Message }
  | { type: "text.delta"; messageId: string; text: string }
  | { type: "tool.start"; messageId: string; tool: string; input: unknown }
  | { type: "tool.output"; messageId: string; tool: string; chunk: string }
  | { type: "tool.end"; messageId: string; tool: string; result: ToolResult }
  | { type: "reasoning.delta"; messageId: string; text: string }
  | {
      type: "step.finish";
      messageId: string;
      tokens: { input: number; output: number };
    }
  | { type: "compaction"; before: number; after: number }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }
  | { type: "tools.changed"; tools: string[] }
  | { type: "error"; error: AgentError }
  | { type: "done"; message: AssistantMessage };

// ── Event emitter ───────────────────────────────────────────────────────────

export type EventHandler = (event: AgentEvent) => void;

export function createEventEmitter(handler?: EventHandler) {
  let current = handler;

  return {
    emit(event: AgentEvent) {
      current?.(event);
    },
    setHandler(h: EventHandler | undefined) {
      current = h;
    },
  };
}
