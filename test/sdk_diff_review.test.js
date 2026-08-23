import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTauSdkDiffReview } from "../src/sdk/diff_review.ts";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRepository() {
  const directory = mkdtempSync(join(tmpdir(), "tau-sdk-diff-review-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: directory });
  writeFileSync(join(directory, "example.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "example.ts"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: directory });
  writeFileSync(join(directory, "example.ts"), "export const value = 2;\n");
  return directory;
}

function createSession(cwd) {
  const closeEphemeralContext = vi.fn(async () => ({ closed: true }));
  const createEphemeralContext = vi.fn(async () => ({ contextId: "context-1" }));
  const submitEphemeralThread = vi.fn(async ({ threadId, message }) => ({
    threadId,
    response: `reply: ${message}`,
  }));

  return {
    session: {
      id: "session-1",
      async snapshot() {
        return {
          executionEnvironment: { kind: "local", cwd },
          bootstrap: { model: { contextWindow: 200_000 } },
        };
      },
      async exec(command, options = {}) {
        const result = spawnSync("/bin/bash", ["-lc", command, ...(options.args ?? [])], {
          cwd: options.cwd ?? cwd,
          env: { ...process.env, ...options.env },
          input: options.stdin,
          encoding: "utf8",
          maxBuffer: options.maxCaptureBytes,
          timeout: options.timeoutMs,
        });
        return {
          output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.status,
          truncated: false,
          timedOut: result.error?.code === "ETIMEDOUT",
          aborted: false,
          closeSignal: result.signal,
        };
      },
      createEphemeralContext,
      submitEphemeralThread,
      closeEphemeralContext,
      onEphemeral() {
        return () => {};
      },
    },
    closeEphemeralContext,
    createEphemeralContext,
    submitEphemeralThread,
  };
}

describe("SDK diff review", () => {
  it("starts the built-in browser UI without a TUI or browser launch", async () => {
    const cwd = createRepository();
    const { session, closeEphemeralContext, createEphemeralContext, submitEphemeralThread } =
      createSession(cwd);
    const review = await startTauSdkDiffReview({
      session,
      source: { kind: "git_diff", diffArgs: ["HEAD"] },
    });

    try {
      const bootstrapResponse = await fetch(`${review.url}api/bootstrap`);
      expect(bootstrapResponse.ok).toBe(true);
      await expect(bootstrapResponse.json()).resolves.toMatchObject({
        context: {
          repoRoot: realpathSync(cwd),
          cwd,
          diffArgs: ["HEAD"],
          diffCommand: "git diff HEAD",
        },
        files: [{ path: "example.ts", status: "modified" }],
      });

      const diffResponse = await fetch(`${review.url}api/diff`);
      expect(diffResponse.ok).toBe(true);
      await expect(diffResponse.json()).resolves.toMatchObject({
        scope: "session",
        patch: expect.stringContaining("+export const value = 2;"),
      });

      await vi.waitFor(() => expect(submitEphemeralThread).toHaveBeenCalledTimes(2));
      expect(createEphemeralContext).toHaveBeenCalledWith(
        expect.not.objectContaining({ reasoning: expect.anything() }),
      );
      expect(submitEphemeralThread.mock.calls[0][0]).not.toHaveProperty("reasoning");
      expect(submitEphemeralThread).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          forkFromThreadId: expect.any(String),
          reasoning: "medium",
        }),
      );
    } finally {
      await review.close();
    }

    await expect(review.result).resolves.toEqual({
      status: "cancelled",
      reason: "controller_cancelled",
    });
    expect(closeEphemeralContext).toHaveBeenCalledWith("context-1");
  });

  it("persists state and durably accepts submissions through client callbacks", async () => {
    const cwd = createRepository();
    const { session } = createSession(cwd);
    let storedDocument;
    const storage = {
      async load() {
        return storedDocument;
      },
      async save(document) {
        storedDocument = structuredClone(document);
      },
    };
    const onSubmit = vi.fn(async () => {});
    const review = await startTauSdkDiffReview({
      session,
      source: { kind: "git_diff", diffArgs: ["HEAD"] },
      storage,
      onSubmit,
    });

    const createdThread = await fetch(`${review.url}api/thread`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchor: { kind: "detached" },
        body: "Please simplify this.",
      }),
    });
    expect(createdThread.ok).toBe(true);
    expect(storedDocument.state.threads).toHaveLength(1);

    const submitted = await fetch(`${review.url}api/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Address the unresolved feedback." }),
    });
    expect(submitted.ok).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({
      review: expect.stringContaining("Address the unresolved feedback."),
      diffCommand: "git diff HEAD",
      reviewedFiles: ["example.ts"],
    });
    await expect(review.result).resolves.toMatchObject({
      status: "returned",
      review: expect.stringContaining("Please simplify this."),
    });
  });
});
