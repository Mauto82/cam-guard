import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workspace packages expose their TypeScript sources under the "source"
    // condition, so tests run against src/ without a build step.
    conditions: ["source"],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
});
