import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { truncateToBytesFromEnd } from "./truncate.js";

export type SpawnCaptureOutputMode = "split" | "combined" | "combined-and-split" | "stderr";
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
    keepStdinOpen?: boolean;
    onSpawn?: (child: ChildProcess) => void;
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
    keepStdinOpen = false,
    onSpawn,
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

    const captureCombined = captureOutput === "combined" || captureOutput === "combined-and-split";
    const captureStdout = captureOutput === "split" || captureOutput === "combined-and-split";
    const captureStderr = captureStdout || captureOutput === "stderr";

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
    let terminationEscalationPending = false;
    let closeResult: SpawnCaptureResult | undefined;

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
      if (killProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // Fall back to killing only the child.
        }
      }

      if (child.killed) return;
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    };

    const processGroupExists = (): boolean => {
      if (!killProcessGroup || !child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

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

    const settleAfterClose = () => {
      if (!closeResult || terminationEscalationPending || settled) return;
      settled = true;
      cleanup();
      resolve(closeResult);
    };

    const requestTermination = (reason: "limit" | "timeout" | "abort") => {
      if (reason === "limit") captureLimitExceeded = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      if (terminationRequested) return;
      terminationRequested = true;
      terminationEscalationPending = killProcessGroup;

      killProcess("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = undefined;
        killProcess("SIGKILL");
        terminationEscalationPending = false;
        settleAfterClose();
      }, killGraceMs);
      if (!killProcessGroup) {
        killTimer.unref?.();
      }
    };

    const abortHandler = () => requestTermination("abort");

    timeoutId =
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
      if (target === "stdout" && captureStdout) {
        appendText(stdoutBuffer, text);
      }
      if (target === "stderr" && captureStderr) {
        appendText(stderrBuffer, text);
      }
    };

    if (stdio[1] === "pipe" && (captureCombined || captureStdout)) {
      child.stdout?.on("data", (chunk) => onData(chunk as Buffer, "stdout"));
    }
    if (stdio[2] === "pipe" && (captureCombined || captureStderr)) {
      child.stderr?.on("data", (chunk) => onData(chunk as Buffer, "stderr"));
    }

    child.on("error", (err) => {
      if (settled || closeResult) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code, signalValue) => {
      if (settled) return;

      const stdoutTail = captureCombined || captureStdout ? stdoutDecoder.end() : "";
      const stderrTail = captureCombined || captureStderr ? stderrDecoder.end() : "";

      if (captureCombined) {
        appendText(outputBuffer, stdoutTail);
        appendText(outputBuffer, stderrTail);
      }
      if (captureStdout) appendText(stdoutBuffer, stdoutTail);
      if (captureStderr) appendText(stderrBuffer, stderrTail);

      closeResult = {
        stdout: captureStdout ? stdoutBuffer.text : "",
        stderr: captureStderr ? stderrBuffer.text : "",
        output: captureCombined ? outputBuffer.text : undefined,
        exitCode: code,
        captureLimitExceeded,
        timedOut,
        aborted,
        closeSignal: signalValue ?? null,
      };

      if (terminationEscalationPending && !processGroupExists()) {
        terminationEscalationPending = false;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
      }
      settleAfterClose();
    });

    try {
      onSpawn?.(child);
      if (input !== undefined && child.stdin) {
        child.stdin.on("error", () => {});
        if (keepStdinOpen) {
          child.stdin.write(input);
        } else {
          child.stdin.end(input);
        }
      }
    } catch (error) {
      settled = true;
      cleanup();
      killProcess("SIGTERM");
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
