import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { truncateToBytesFromEnd } from "./truncate.js";

export type SpawnCaptureOutputMode = "split" | "combined" | "combined-and-split";
export type SpawnCaptureStrategy = "head" | "tail";

export type SpawnCaptureResult = {
  stdout: string;
  stderr: string;
  output?: string;
  exitCode: number | null;
  captureLimitExceeded: boolean;
  timedOut: boolean;
  aborted: boolean;
  closeSignal: NodeJS.Signals | null;
};

type CaptureBuffer = {
  text: string;
  bytes: number;
};

function appendWithTail(buffer: CaptureBuffer, text: string, maxBytes: number): void {
  if (!text) return;

  if (!Number.isFinite(maxBytes)) {
    buffer.text += text;
    buffer.bytes += Buffer.byteLength(text, "utf-8");
    return;
  }

  buffer.text += text;
  buffer.bytes += Buffer.byteLength(text, "utf-8");
  if (buffer.bytes <= maxBytes) return;

  buffer.text = truncateToBytesFromEnd(buffer.text, maxBytes);
  buffer.bytes = Buffer.byteLength(buffer.text, "utf-8");
}

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
    maxCaptureStrategy?: SpawnCaptureStrategy;
    captureOutput?: SpawnCaptureOutputMode;
    killGraceMs?: number;
    killProcessGroup?: boolean;
    stdio?: ["ignore" | "pipe", "ignore" | "pipe", "ignore" | "pipe"];
    input?: string | Buffer;
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
    maxCaptureStrategy = "head",
    captureOutput = "split",
    killGraceMs = 2000,
    killProcessGroup = false,
    stdio: stdioOption,
    input,
  } = options;
  const stdio =
    stdioOption ?? (input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      shell,
      windowsHide,
      detached,
      stdio,
    });

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }

    const captureCombined = captureOutput === "combined" || captureOutput === "combined-and-split";
    const captureSplit = captureOutput === "split" || captureOutput === "combined-and-split";

    const stdoutBuffer: CaptureBuffer = { text: "", bytes: 0 };
    const stderrBuffer: CaptureBuffer = { text: "", bytes: 0 };
    const outputBuffer: CaptureBuffer = { text: "", bytes: 0 };

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    let captureBytes = 0;
    let captureLimitExceeded = false;
    let captureFrozen = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let terminationRequested = false;

    const appendText = (buffer: CaptureBuffer, text: string): void => {
      if (!text) return;
      if (maxCaptureStrategy === "tail") {
        appendWithTail(buffer, text, maxCaptureBytes);
        return;
      }
      buffer.text += text;
      buffer.bytes += Buffer.byteLength(text, "utf-8");
    };

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
        if (maxCaptureMode === "terminate") {
          requestTermination("limit");
        }
        if (maxCaptureStrategy === "head") {
          captureFrozen = true;
          return;
        }
      }

      const text = (target === "stdout" ? stdoutDecoder : stderrDecoder).write(chunk);
      if (captureCombined) {
        appendText(outputBuffer, text);
      }
      if (captureSplit) {
        if (target === "stdout") {
          appendText(stdoutBuffer, text);
        } else {
          appendText(stderrBuffer, text);
        }
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

    child.on("close", (code, signalValue) => {
      if (settled) return;
      settled = true;
      cleanup();

      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();

      if (captureCombined) {
        appendText(outputBuffer, stdoutTail);
        appendText(outputBuffer, stderrTail);
      }
      if (captureSplit) {
        appendText(stdoutBuffer, stdoutTail);
        appendText(stderrBuffer, stderrTail);
      }

      resolve({
        stdout: captureSplit ? stdoutBuffer.text : "",
        stderr: captureSplit ? stderrBuffer.text : "",
        output: captureCombined ? outputBuffer.text : undefined,
        exitCode: code,
        captureLimitExceeded,
        timedOut,
        aborted,
        closeSignal: signalValue ?? null,
      });
    });
  });
}
