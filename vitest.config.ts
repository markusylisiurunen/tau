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
          // These files share one module graph per worker, so they must not mock modules or stub
          // globals, and must restore any process state they change, such as umask or fake timers.
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
