import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "ai-sdk": "src/adapters/ai-sdk.ts",
    "openrouter-sdk": "src/adapters/openrouter-sdk.ts",
    "tanstack-ai": "src/adapters/tanstack-ai.ts",
  },
  tsconfig: "tsconfig.tsup.json",
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "esnext",
  loader: {
    ".txt": "text",
  },
});
