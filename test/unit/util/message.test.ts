import { describe, expect, test } from "bun:test";
import { getAssistantText } from "../../../src/util/message.ts";
import { assistantWithTools } from "../../test-helpers.ts";

describe("getAssistantText", () => {
  test("concatenates only assistant text parts", () => {
    const message = assistantWithTools(
      [
        {
          type: "tool",
          id: "call-1",
          tool: "read",
          input: { path: "/note.txt" },
          state: { status: "completed", output: "hello", duration: 1 },
        },
      ],
      "Hello",
    );

    message.parts.splice(1, 0, { type: "text", text: ", world" });

    expect(getAssistantText(message)).toBe("Hello, world");
  });
});
