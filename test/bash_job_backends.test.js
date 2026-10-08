import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { BashJobRegistry } from "../dist/core/tools/bash_jobs.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createFlySpriteToolExecutionBackend } from "../dist/execution/fly_sprite_execution_environment.js";

function killIfRunning(pid) {
  if (!(pid > 0)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

for (const kind of ["local", "Sprite"]) {
  describe.concurrent(`${kind} Bash jobs`, () => {
    const createBackend = () =>
      kind === "local"
        ? createLocalToolExecutionBackend()
        : createFlySpriteToolExecutionBackend({
            cwd: process.cwd(),
            sprite: {
              spawn: (command, args, options) =>
                spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }),
            },
          });

    it("captures bounded streamed output and natural completion", async () => {
      const backend = createBackend();
      const jobs = new BashJobRegistry();
      const signal = new AbortController().signal;
      try {
        const id = await jobs.start(
          backend,
          'node -e \'process.stdout.write("x".repeat(100000) + "TAIL")\'',
          process.cwd(),
          signal,
        );
        const result = await jobs.wait([id], 5000, signal, true);
        expect(result).toContain("TAIL");
        expect(result).toContain("truncated");
        expect(result.length).toBeLessThan(14000);
        expect(jobs.read([id])).toEqual([
          expect.objectContaining({ status: "succeeded", exitCode: 0, truncated: true }),
        ]);
        expect(await jobs.wait([id], 1, signal, true)).toContain("succeeded");
      } finally {
        try {
          await jobs.dispose();
        } finally {
          await backend.dispose();
        }
      }
    });

    it("kills a TERM-ignoring child on shutdown", async () => {
      const backend = createBackend();
      const jobs = new BashJobRegistry();
      let pid;
      let shutdownTimeout;
      try {
        const id = await jobs.start(
          backend,
          "bash -c 'trap \"\" TERM; echo $$; exec sleep 100' & wait",
          process.cwd(),
          new AbortController().signal,
        );
        await vi.waitFor(() => {
          pid = Number(
            jobs
              .format([id])
              .split("\n")
              .find((line) => /^\d+$/.test(line)),
          );
          expect(pid).toBeGreaterThan(0);
        });
        await Promise.race([
          jobs.dispose(),
          new Promise((_, reject) => {
            shutdownTimeout = setTimeout(() => reject(new Error("shutdown timed out")), 4000);
          }),
        ]);
        expect(jobs.read([id])).toEqual([
          expect.objectContaining({ status: "stopped", aborted: true }),
        ]);
        await vi.waitFor(() => {
          expect(() => process.kill(pid, 0)).toThrow();
        });
      } finally {
        clearTimeout(shutdownTimeout);
        try {
          killIfRunning(pid);
        } finally {
          try {
            await jobs.dispose();
          } finally {
            await backend.dispose();
          }
        }
      }
    });
  });
}
