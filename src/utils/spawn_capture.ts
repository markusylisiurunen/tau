import { spawn } from "node:child_process";

export type SpawnCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  captureLimitExceeded: boolean;
  timedOut: boolean;
  aborted: boolean;
  closeSignal: NodeJS.Signals | null;
};

export async function spawnWithCapture(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    windowsHide?: boolean;
    detached?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxCaptureBytes?: number;
    maxCaptureMode?: "terminate" | "ignore";
    killGraceMs?: number;
    killProcessGroup?: boolean;
    stdio?: ["ignore" | "pipe", "ignore" | "pipe", "ignore" | "pipe"];
  } = {},
): Promise<SpawnCaptureResult> {
  const {
    cwd,
    env,
    shell,
    windowsHide,
    detached,
    signal,
    timeoutMs,
    maxCaptureBytes = Number.POSITIVE_INFINITY,
    maxCaptureMode = "terminate",
    killGraceMs = 2000,
    killProcessGroup = false,
    stdio = ["ignore", "pipe", "pipe"],
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      shell,
      windowsHide,
      detached,
      stdio,
    });

    let stdout = "";
    let stderr = "";
    let captureBytes = 0;
    let captureLimitExceeded = false;
    let captureFrozen = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let terminationRequested = false;

    const killProcess = (sig: NodeJS.Signals) => {
      if (child.killed) return;
      if (killProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // Fall back to killing only the child.
        }
      }

      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    };

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const requestTermination = (reason: "limit" | "timeout" | "abort") => {
      if (reason === "limit") captureLimitExceeded = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      if (terminationRequested) return;
      terminationRequested = true;

      killProcess("SIGTERM");
      killTimer = setTimeout(() => killProcess("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    };

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    };

    const abortHandler = () => requestTermination("abort");

    const timeoutId =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => requestTermination("timeout"), timeoutMs)
        : undefined;
    timeoutId?.unref?.();

    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const onData = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (captureFrozen) return;

      captureBytes += chunk.length;
      if (captureBytes > maxCaptureBytes) {
        captureLimitExceeded = true;
        captureFrozen = true;
        if (maxCaptureMode === "terminate") {
          requestTermination("limit");
        }
        return;
      }

      const text = chunk.toString("utf-8");
      if (target === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    if (stdio[1] === "pipe") {
      child.stdout?.on("data", (chunk) => onData(chunk as Buffer, "stdout"));
    }
    if (stdio[2] === "pipe") {
      child.stderr?.on("data", (chunk) => onData(chunk as Buffer, "stderr"));
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: code,
        captureLimitExceeded,
        timedOut,
        aborted,
        closeSignal: signal ?? null,
      });
    });
  });
}
