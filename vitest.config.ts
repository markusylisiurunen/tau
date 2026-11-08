import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    maxWorkers: "100%",
    setupFiles: ["test/setup.js"],
    projects: [
      {
        test: {
          name: "shared",
          include: ["test/**/*.shared.test.js"],
          // These tests own their state and do not mock modules or native process globals.
          isolate: false,
          restoreMocks: true,
        },
      },
      {
        test: {
          name: "isolated",
          include: ["test/**/*.test.js"],
          exclude: ["test/**/*.shared.test.js"],
        },
      },
    ],
  },
});
