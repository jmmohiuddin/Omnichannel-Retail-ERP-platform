import { defineConfig } from "vitest/config";

/**
 * Logic-layer tests only. Everything under src/lib is plain TypeScript with no
 * React Native imports, so the suite runs in a node environment — screens and
 * App.tsx are covered by `tsc --noEmit` (this machine has no native toolchain).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
