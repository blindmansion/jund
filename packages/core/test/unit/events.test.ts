import { describe, test, expect } from "bun:test";
import { createEventEmitter } from "../../src/events.ts";
import type { AgentEvent } from "../../src/events.ts";

describe("createEventEmitter", () => {
  test("emits events to the handler", () => {
    const received: AgentEvent[] = [];
    const emitter = createEventEmitter((e) => received.push(e));

    emitter.emit({ type: "text.delta", messageId: "m1", text: "hello" });

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("text.delta");
  });

  test("silently does nothing with no handler", () => {
    const emitter = createEventEmitter();
    // should not throw
    emitter.emit({ type: "text.delta", messageId: "m1", text: "hello" });
  });

  test("setHandler replaces the current handler", () => {
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];

    const emitter = createEventEmitter((e) => first.push(e));
    emitter.emit({ type: "text.delta", messageId: "m1", text: "a" });

    emitter.setHandler((e) => second.push(e));
    emitter.emit({ type: "text.delta", messageId: "m1", text: "b" });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  test("setHandler to undefined stops emission", () => {
    const received: AgentEvent[] = [];
    const emitter = createEventEmitter((e) => received.push(e));

    emitter.emit({ type: "text.delta", messageId: "m1", text: "a" });
    emitter.setHandler(undefined);
    emitter.emit({ type: "text.delta", messageId: "m1", text: "b" });

    expect(received).toHaveLength(1);
  });

  test("handles various event types", () => {
    const received: AgentEvent[] = [];
    const emitter = createEventEmitter((e) => received.push(e));

    emitter.emit({ type: "compaction", before: 100, after: 10 });
    emitter.emit({ type: "retry", attempt: 1, maxAttempts: 3, delayMs: 1000, error: "429" });
    emitter.emit({ type: "tools.changed", tools: ["read", "write"] });

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.type)).toEqual(["compaction", "retry", "tools.changed"]);
  });
});
