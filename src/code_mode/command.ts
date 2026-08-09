import {
  executeTauCodeMode,
  type TauCodeModeDefinition,
  validateTauCodeModeDefinition,
} from "./runtime.js";

const MAX_COMMAND_REQUEST_BYTES = 1024 * 1024;

type TauCodeModeCommandRequest = {
  version: 1;
  sessionId: string;
  callId: string;
  arguments: {
    code: string;
  };
};

export async function runTauCodeModeCommand(definition: TauCodeModeDefinition): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  try {
    validateTauCodeModeDefinition(definition);
    const request = parseCommandRequest(await readCommandRequest());
    const result = await executeTauCodeMode({
      ...definition,
      code: request.arguments.code,
      signal: controller.signal,
      invocation: {
        sessionId: request.sessionId,
        callId: request.callId,
      },
    });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

async function readCommandRequest(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_COMMAND_REQUEST_BYTES) {
      throw new Error(`code-mode command request exceeded ${MAX_COMMAND_REQUEST_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function parseCommandRequest(input: string): TauCodeModeCommandRequest {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("code-mode command received invalid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("code-mode command received an invalid request");
  }
  const request = value as Record<string, unknown>;
  if (
    request.version !== 1 ||
    typeof request.sessionId !== "string" ||
    !request.sessionId ||
    typeof request.callId !== "string" ||
    !request.callId ||
    typeof request.arguments !== "object" ||
    request.arguments === null
  ) {
    throw new Error("code-mode command received an invalid version-1 request");
  }
  const args = request.arguments as Record<string, unknown>;
  if (
    typeof args.code !== "string" ||
    !args.code.trim() ||
    Object.keys(args).some((key) => key !== "code")
  ) {
    throw new Error("code-mode command arguments must contain exactly one non-empty 'code' string");
  }
  return value as TauCodeModeCommandRequest;
}
