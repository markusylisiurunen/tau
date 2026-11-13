import type { Readable } from "node:stream";
import { ReadStream } from "node:tty";
import { inspect, parseArgs } from "node:util";
import { createTauSdkClient } from "../../sdk/client.js";
import type { TauSdkClient, TauSdkSession, TauSdkSessionTurnOutcome } from "../../sdk/types.js";
import { parsePersonaOption } from "../cli.js";

export const runHelp = `usage:
  tau run [--persona <id>[:<level>]] [--no-agent-context-files] [--json] < task.txt
  tau run --session <id> [--json] < task.txt

run one turn with the task read from stdin, then exit. without --session, this
starts a new session in the current directory. --session continues a saved session
in its own working directory, with its persona and settings. the session must not
be open in another Tau process, such as a TUI.

stdout gets the final assistant response. with --json, it gets one JSON object:
  {"sessionId":"...","turn":{"status":"completed","stopReason":"stop"},"response":"..."}
stderr gets the session ID as soon as it is known, then progress and diagnostics.
the exit code is nonzero if the turn fails, is blocked, or is interrupted.

the agent uses Tau's tools and permissions, independently of the caller. background
jobs stop when the command exits. use tau history read <id> to see the transcript.

options:
  --persona, -p <id>[:<level>]  persona and reasoning level for a new session.
  --session <id>                continue a saved session.
  --json                        print the result as JSON.
  --no-agent-context-files      do not load AGENTS.md into a new session.
  --help, -h                    show this help without reading stdin.`;

export async function runHeadlessCommand(
  argv: string[],
  options: {
    cwd?: string;
    stdin?: Readable;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    signal?: AbortSignal;
    createClient?: typeof createTauSdkClient;
  } = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      persona: { type: "string", short: "p" },
      session: { type: "string" },
      json: { type: "boolean" },
      "no-agent-context-files": { type: "boolean" },
    },
  });
  if (values.help) {
    stdout(`${runHelp}\n`);
    return 0;
  }
  if (
    values.session !== undefined &&
    (!values.session || values.persona !== undefined || values["no-agent-context-files"])
  ) {
    throw new Error("--session requires an ID and cannot be combined with new-session options");
  }
  const persona = values.persona === undefined ? undefined : parsePersonaOption(values.persona);
  const stdin = options.stdin ?? process.stdin;
  if (stdin instanceof ReadStream && stdin.isTTY)
    throw new Error("tau run requires a task on stdin");
  options.signal?.throwIfAborted();
  let client: TauSdkClient | undefined;
  let session: TauSdkSession | undefined;
  let interrupt: Promise<unknown> | undefined;
  let readingInput = true;
  const onAbort = () => {
    if (readingInput) stdin.destroy(new Error("run interrupted"));
    if (session)
      interrupt ??= session
        .interrupt()
        .catch((error: unknown) => stderr(`failed to interrupt: ${String(error)}\n`));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let shutdownFailed = false;
  let result: { sessionId: string; turn: TauSdkSessionTurnOutcome; response: string };
  try {
    let input = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) input += chunk;
    readingInput = false;
    if (!input.trim()) throw new Error("tau run requires a nonempty task on stdin");
    client = await (options.createClient ?? createTauSdkClient)({
      cwd: options.cwd ?? process.cwd(),
      noAgentContextFiles: values["no-agent-context-files"],
      requireCompleteHistory: true,
      initialize: { client: { name: "tau-run", version: "1" } },
      onDiagnostic: (diagnostic) => stderr(`${JSON.stringify(diagnostic)}\n`),
    });
    options.signal?.throwIfAborted();
    session = values.session
      ? await client.sessions.observe(values.session)
      : await client.sessions.create({
          executionEnvironment: { kind: "local", cwd: options.cwd ?? process.cwd() },
          attributes: { source: "cli" },
          ...(persona
            ? { personaId: persona.personaId, reasoning: persona.reasoningOverride }
            : {}),
        });
    stderr(`session: ${session.id}\n`);
    options.signal?.throwIfAborted();
    stderr("running task\n");
    const { turn, response } = await session.submit(input);
    await interrupt;
    result = { sessionId: session.id, turn, response };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      await client?.close();
    } catch (error) {
      shutdownFailed = true;
      stderr(`failed to shut down: ${inspect(error, { depth: null, colors: false })}\n`);
    }
  }
  const { turn, response } = result;
  stderr(`turn: ${turn.status}\n`);
  if (turn.status === "failed" && turn.errorMessage) stderr(`${turn.errorMessage}\n`);
  if (turn.status === "blocked") stderr(`${turn.message}\n`);
  if (values.json) stdout(`${JSON.stringify(result)}\n`);
  else stdout(response);
  return turn.status === "completed" && !options.signal?.aborted && !shutdownFailed ? 0 : 1;
}
