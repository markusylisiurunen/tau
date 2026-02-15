import { describe, expect, it, vi } from "vitest";
import {
  matchesCronSchedule,
  parseCronSchedule,
  startAsyncCronScheduler,
} from "../dist/core/async/cron.js";

describe("async cron", () => {
  it("parses cron schedules and matches expected timestamps", () => {
    const schedule = parseCronSchedule("0 2 * * *");

    expect(matchesCronSchedule(schedule, new Date(2026, 0, 15, 2, 0, 0))).toBe(true);
    expect(matchesCronSchedule(schedule, new Date(2026, 0, 15, 2, 1, 0))).toBe(false);
  });

  it("starts scheduled sessions at matching minute boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 1, 0, 30));

    try {
      const createSession = vi.fn(async () => ({
        id: "session-1",
        projectId: "tau",
        state: "queued",
        createdAt: "",
        updatedAt: "",
      }));

      const scheduler = startAsyncCronScheduler({
        jobs: {
          nightly: {
            projectId: "tau",
            schedule: "* * * * *",
            prompt: "check docs drift",
          },
        },
        sessionManager: { createSession },
        additionalSystemMessage: "you are running from a scheduled cron job",
        pollIntervalMs: 1000,
      });

      await Promise.resolve();
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(createSession).toHaveBeenNthCalledWith(1, {
        projectId: "tau",
        prompt: "check docs drift",
        additionalSystemMessage: "you are running from a scheduled cron job",
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(createSession).toHaveBeenCalledTimes(2);

      await scheduler.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(createSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records runs and supports manual triggering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 1, 0, 0));

    try {
      const createSession = vi.fn(async () => ({
        id: "session-1",
        projectId: "tau",
        state: "queued",
        createdAt: "",
        updatedAt: "",
      }));

      const scheduler = startAsyncCronScheduler({
        jobs: {
          nightly: {
            projectId: "tau",
            schedule: "* * * * *",
            prompt: "check docs drift",
          },
        },
        sessionManager: { createSession },
        pollIntervalMs: 1000,
      });

      await Promise.resolve();

      expect(scheduler.listJobs()).toEqual([
        {
          id: "nightly",
          projectId: "tau",
          schedule: "* * * * *",
          prompt: "check docs drift",
        },
      ]);

      const run = await scheduler.triggerJobNow("nightly");
      expect(run.status).toBe("session-created");

      const runs = scheduler.listRuns({ jobId: "nightly", limit: 2 });
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]?.jobId).toBe("nightly");

      await scheduler.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs cron session creation errors without throwing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 1, 0, 0));

    try {
      const createSession = vi.fn(async () => {
        throw new Error("boom");
      });
      const logs = [];

      const scheduler = startAsyncCronScheduler({
        jobs: {
          nightly: {
            projectId: "tau",
            schedule: "* * * * *",
            prompt: "check docs drift",
          },
        },
        sessionManager: { createSession },
        pollIntervalMs: 1000,
        onLog: (entry) => {
          logs.push(entry);
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(
        logs.some(
          (entry) =>
            entry.level === "error" && entry.message === "cron job failed to create session",
        ),
      ).toBe(true);

      await scheduler.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
