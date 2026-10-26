import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Safety net: automated tests must never reach the real network.
    // All RPC and execution adapters used in tests are in-memory mocks.
    passWithNoTests: false
  }
});
