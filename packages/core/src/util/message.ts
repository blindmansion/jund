import type { AssistantMessage } from "../types.ts";

export function getAssistantText(message: AssistantMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<AssistantMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}
