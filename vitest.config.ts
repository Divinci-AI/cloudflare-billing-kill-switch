import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Worker safety limits — a runaway pool freezes the machine.
    isolate: true,
    pool: "threads",
    poolOptions: {
      threads: { singleThread: false, maxThreads: 2, minThreads: 1 },
    },
  },
});
