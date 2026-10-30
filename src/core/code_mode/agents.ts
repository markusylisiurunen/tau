import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { AgentRequestError } from "../subagents/errors.js";
import { parseSubagentLaunchModel } from "../subagents/launch_model.js";
import { resolveSubagentEffectiveSettings } from "../subagents/registry.js";
import type {
  ResolveSubagentPrompt,
  SubagentLaunchModel,
  SubagentRuntimeConfig,
} from "../subagents/types.js";
import type { AgentJobRegistry } from "../tools/agent_jobs.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { Persona } from "../types.js";
import type { CodeModeCapability } from "./capability.js";

export type AgentsCapabilityOptions = {
  backend: ToolExecutionBackend;
  jobs: AgentJobRegistry;
  supervisor: AgentSupervisor;
  persona: Persona;
  config: Config;
  modelResolver: ModelResolver;
  subagentSystemPrompt: string | undefined;
  history: HistoryQuery;
  mcp?: McpManager;
  cwd: string;
  resolveSubagentPrompt?: ResolveSubagentPrompt;
};
const id = z.string().min(1).max(256);
const idOptions = z.strictObject({ id });
const message = z
  .string()
  .trim()
  .min(1)
  .max(256 * 1024);
const spawnOptions = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[^\r\n]+$/),
  prompt: message,
  model: z.string().min(1).optional(),
  workingDirectory: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/)
    .optional(),
});
const traceOptions = z.strictObject({
  id,
  kinds: z
    .array(z.enum(["input", "assistant", "tool_call", "tool_result", "notice", "status"]))
    .max(6)
    .optional(),
  toolName: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(4096).optional(),
});

export function createAgentsCapability(
  options: AgentsCapabilityOptions,
  originHistoryEntryId: string,
): CodeModeCapability {
  const supervisor: AgentSupervisor = options.supervisor;
  const capability: CodeModeCapability = {
    name: "agents",
    description:
      "Start delegated workers, send them queued or steering input, interrupt and wait for them, and read selected parts of their conversations. Follow the delegation policy in your instructions. Workers keep running when a program ends or is cancelled.",
    documentation: `# tau.agents

Start general-purpose workers, send them more input, and read what they did. Start workers only when the user or active instructions explicitly ask for delegation.

A worker has one conversation that grows with every input you send. Workers belong to the current session. They keep running when the program that started them ends or is cancelled, and they are lost when the session ends or Tau restarts. Results you need later must reach your conversation or a file before then.

Reading data into the program does not add it to your conversation. Only what you print does, so select and print the parts you need.

## Interface

\`\`\`ts
type AgentsApi = {
  spawn(options: SpawnOptions): Promise<AgentState>;
  list(): Promise<ListResult>;
  read(options: { id: string }): Promise<AgentState>;
  sendInput(options: SendInputOptions): Promise<AgentState>;
  interrupt(options: InterruptOptions): Promise<AgentState>;
  waitUntilIdle(options: { id: string }): Promise<AgentState>;
  trace(options: TraceOptions): Promise<TracePage>;
  readContent(options: ReadContentOptions): Promise<ContentPage>;
  readText(options: ReadTextOptions): Promise<ReadTextResult>;
};
\`\`\`

## Worker state

\`\`\`ts
type AgentState = {
  id: string;
  title: string;
  model: string; // provider/model:effort
  workingDirectory: string;
  pending: { queue: number; steer: number };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextTokens: number;
    contextWindow: number;
    cost: number;
  };
} & (
  | { status: "working" | "stopping" }
  | { status: "idle"; reason: "completed" | "interrupted" }
  | { status: "idle"; reason: "failed"; error: { code: string; message: string } }
);
\`\`\`

A worker is idle when it has no active turn and no pending input. \`reason\` tells how its latest turn ended. \`completed\` means the turn ended normally. It does not mean the task succeeded, so read the worker's answer before relying on it. A failed or interrupted turn may leave only a partial answer, or none.

\`pending\` counts input awaiting delivery by Tau. Delivery to a runtime does not confirm that the worker has read it. Token counts and \`cost\` are totals for the whole conversation. \`contextTokens\` estimates the current context size.

## \`tau.agents.spawn(options)\`

\`\`\`ts
type SpawnOptions = {
  title: string;
  prompt: string;
  model?: string;
  workingDirectory?: string;
};
\`\`\`

- \`title\`: required single line, 1–256 characters.
- \`prompt\`: required first message, at most 262,144 characters. The worker cannot see your conversation, so include everything it needs.
- \`model\`: omit it to use your own model and settings. Set it only when the user or active instructions ask for a specific model; it must exactly match an allowed override from your instructions.
- \`workingDirectory\`: absolute, or relative to your working directory. Defaults to your working directory.

Returns as soon as the worker starts. At most 8 workers can be working at once.

## \`tau.agents.list()\`

\`\`\`ts
type ListResult = {
  agents: AgentState[];
  capacity: { running: number; limit: number };
};
\`\`\`

Lists every worker in this session, including idle ones.

## \`tau.agents.read(options)\`

Returns one worker's current state.

## \`tau.agents.sendInput(options)\`

\`\`\`ts
type SendInputOptions = {
  id: string;
  message: string;
  mode: "queue" | "steer";
};
\`\`\`

\`mode\` is required:

- \`queue\`: the worker finishes its current work first, then handles the message as a separate turn. Queued messages run in the order you send them.
- \`steer\`: the worker takes the message into account as soon as possible during its current turn. Use it to correct or narrow work in progress. Steering does not stop a running tool; use \`interrupt\` for that.

Either mode starts a new turn right away when the worker is idle. A steering message that arrives too late for the current turn is handled in a later turn. The worker keeps its conversation, model, tools, and working directory.

The call returns when the input is accepted, before the worker reads it. It fails while the worker is stopping, when 64 inputs are already pending, or when the worker is idle and 8 workers are already working.

## \`tau.agents.interrupt(options)\`

\`\`\`ts
type InterruptOptions = { id: string; wait?: boolean };
\`\`\`

Stops the current turn and discards all pending input, so the worker does not continue with queued work. With the default \`wait: true\`, the call returns after the turn has ended. With \`wait: false\`, it returns right away, and the status may still be \`stopping\`. If the program's deadline passes first, the worker still stops, but the call does not confirm it. Interrupting an idle worker only returns its state.

Background Bash and code jobs that the worker started keep running. The worker stays available for more input.

## \`tau.agents.waitUntilIdle(options)\`

Waits until the worker has no active turn and no pending input, then returns its state. This includes queued messages. It returns immediately for an idle worker. A failed or interrupted worker returns idle state; the call does not throw for it. The wait does not include background jobs the worker started.

Cancelling the wait, for example when the program stops, leaves the worker running. Wait for several workers with \`Promise.all\`. Outside a program, use the \`wait_for_agents\` tool.

An idle state is an observation at one moment. Another caller can send the worker new input afterwards.

## \`tau.agents.trace(options)\`

Reads a page of the worker's conversation.

\`\`\`ts
type TraceOptions = {
  id: string;
  kinds?: TraceKind[];
  toolName?: string;
  limit?: number;
  cursor?: string;
};

type TracePage = {
  entries: TraceEntry[];
  nextCursor: string | null;
  historyEvicted: boolean;
};

type TraceEntry = { seq: number; timestamp: number } & (
  | { kind: "input"; mode: "initial" | "queue" | "steer"; content: Content }
  | { kind: "assistant"; content: Content }
  | { kind: "tool_call"; callId: string; toolName: string; arguments: Content }
  | {
      kind: "tool_result";
      callId: string;
      toolName: string;
      outcome: "succeeded" | "failed" | "blocked" | "cancelled";
      content: Content;
    }
  | { kind: "notice"; code: string; content: Content }
  | {
      kind: "status";
      status: "working" | "stopping" | "idle";
      reason?: "completed" | "failed" | "interrupted";
    }
);

type TraceKind = TraceEntry["kind"];

type Content =
  | { kind: "inline"; blocks: ContentBlock[] }
  | { kind: "reference"; ref: string; bytes: number };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "image"; mimeType: string; data: string } // base64
  | { type: "unavailable"; reason: string };
\`\`\`

- \`kinds\`: only entries of these kinds. Omit for all kinds.
- \`toolName\`: only tool calls and results of this tool. Tool names are the worker's own, such as \`bash\` for a Tau worker or \`Bash\` for a Claude Code worker.
- \`limit\`: integer 1–50, default 20.
- \`cursor\`: \`nextCursor\` from an earlier page. Keep \`kinds\` and \`toolName\` unchanged.

The first page holds the newest matching entries, in chronological order. \`nextCursor\` leads to older entries. A cursor keeps its starting point, so new activity does not shift the pages. Call without a cursor to see the latest entries again. \`seq\` increases with every entry and identifies it for \`readText\`.

The trace contains:

- \`input\`: each message you sent, recorded when it was accepted.
- \`assistant\`: the worker's message text. Reasoning is not included.
- \`tool_call\`: the tool and its arguments as one JSON block.
- \`tool_result\`: the result exactly as the worker received it. Output that the tool itself shortened stays shortened.
- \`notice\`: events with a machine-readable \`code\`. \`input.discarded\` means an interrupt dropped pending input. \`compaction.compacted\`, \`compaction.skipped\`, \`compaction.aborted\`, and \`compaction.failed\` report context compaction. A failed turn adds a notice whose \`code\` matches the state's \`error.code\`.
- \`status\`: the worker started working, began stopping, or became idle.

System prompts are not included.

Content is inline when it is at most 4,096 bytes as JSON and has no images. Otherwise the entry holds a \`reference\`; read it with \`readText\` or \`readContent\`. A single content value larger than 6 MiB is replaced by an \`unavailable\` block.

Each worker keeps its newest 4,096 entries, up to 16 MiB in total. Older entries and their references are then removed, and \`historyEvicted\` is \`true\`.

## \`tau.agents.readText(options)\`

\`\`\`ts
type ReadTextOptions = { id: string; seq: number; maxChars?: number };
type ReadTextResult = { text: string; complete: boolean };
\`\`\`

Returns the text of one \`assistant\` or \`tool_result\` entry, whether it is inline or a reference. \`maxChars\` is 1–100,000 UTF-16 code units, default 30,000. \`complete\` is \`false\` when the text was cut at \`maxChars\` or the content contains an \`unavailable\` block. It does not detect output that the tool itself shortened. Content with JSON or images fails; use \`readContent\` for it.

## \`tau.agents.readContent(options)\`

\`\`\`ts
type ReadContentOptions = { id: string; ref: string; cursor?: string };
type ContentPage = { blocks: ContentBlock[]; nextCursor: string | null };
\`\`\`

Reads referenced content one block per page. Long text arrives in chunks of at most 16,384 UTF-16 code units; join the chunks to get the exact text. JSON and image blocks arrive whole. Pass \`nextCursor\` to read the next page, until it is \`null\`.

An image reaches your conversation only if you pass it to \`printImage\`.

## Errors

A failed call throws an error with a \`code\` and a \`message\`:

| \`code\` | Meaning |
| --- | --- |
| \`invalid_arguments\` | The options do not match the interface. |
| \`unknown_agent\` | No worker in this session has the ID. |
| \`invalid_cursor\` | The cursor is malformed, belongs to another query or reference, or comes from another worker. |
| \`expired_content\` | The entry or reference was removed by retention, or never existed. |
| \`content_type\` | \`readText\` was used on an entry of another kind, or on content with JSON or images. |
| \`operation_failed\` | The request was refused, for example at the capacity or pending-input limit. |
| \`cancelled\` | The program was cancelled during the call. |

A worker's failure is part of its state and trace, not an error from these calls. No call is retried automatically.

## Examples

Start a worker, wait for it, and print its answer:

\`\`\`js
const worker = await tau.agents.spawn({
  title: "review authentication",
  prompt: "Review the authentication changes in src/auth. Do not edit files. Report findings.",
});
const state = await tau.agents.waitUntilIdle({ id: worker.id });
if (state.status !== "idle" || state.reason !== "completed")
  throw new Error(\`worker did not complete: \${JSON.stringify(state)}\`);
const page = await tau.agents.trace({ id: worker.id, kinds: ["assistant"], limit: 1 });
const answer = page.entries[0];
if (!answer) throw new Error("worker gave no answer");
const report = await tau.agents.readText({ id: worker.id, seq: answer.seq });
printText(report.text);
if (!report.complete) printText("(answer incomplete)");
\`\`\`

Redirect work in progress, then queue a separate task. Here and below, \`id\` is the ID of an earlier worker:

\`\`\`js
await tau.agents.sendInput({ id, mode: "steer", message: "Focus on expired sessions only." });
await tau.agents.sendInput({ id, mode: "queue", message: "Then review the logout flow." });
\`\`\`

Print the beginning of each recent failed Bash result:

\`\`\`js
const page = await tau.agents.trace({ id, kinds: ["tool_result"], toolName: "bash", limit: 10 });
for (const entry of page.entries) {
  if (entry.outcome === "succeeded") continue;
  const { text, complete } = await tau.agents.readText({ id, seq: entry.seq, maxChars: 2000 });
  printText(\`#\${entry.seq}\${complete ? "" : " (shortened)"}: \${text}\`);
}
\`\`\`
`,
    api: {
      spawn: async (args, context) => {
        const [input] = z.tuple([spawnOptions]).parse(args);
        context.signal.throwIfAborted();
        let launchModel: SubagentLaunchModel | undefined;
        if (input.model) {
          const parsed = parseSubagentLaunchModel(input.model, {
            resolveModel: options.modelResolver,
          });
          if (
            !parsed.launchModel ||
            !options.persona.subagentLaunchModels.includes(parsed.launchModel.normalized)
          )
            throw new Error(parsed.error ?? "Subagent launch model is not allowed");
          launchModel = parsed.launchModel;
        }
        const settings = resolveSubagentEffectiveSettings({
          persona: options.persona,
          launchModel,
        });
        const cwd = resolve(options.cwd, input.workingDirectory ?? ".");
        let runtimeConfig: SubagentRuntimeConfig;
        if (settings.kind === "claude-code") runtimeConfig = { ...settings, workingDirectory: cwd };
        else {
          const systemPrompt =
            cwd === resolve(options.cwd)
              ? options.subagentSystemPrompt
              : await options.resolveSubagentPrompt?.({ cwd, persona: options.persona });
          if (!systemPrompt)
            throw new Error("Subagent working-directory instructions are unavailable");
          runtimeConfig = { ...settings, workingDirectory: cwd, systemPrompt };
        }
        context.signal.throwIfAborted();
        const result = supervisor.spawn({
          ...options,
          runtimeConfig,
          prompt: input.prompt,
          title: input.title,
          originHistoryEntryId,
          personaId: options.persona.id,
        });
        if (!result.ok) throw new Error(result.reason);
        return supervisor.read(result.state.id);
      },
      list: (args) => {
        z.tuple([]).parse(args);
        return {
          agents: supervisor.listSnapshots().map((state) => supervisor.read(state.id)),
          capacity: supervisor.getCapacity(),
        };
      },
      read: (args) => {
        const [input] = z.tuple([idOptions]).parse(args);
        return supervisor.read(input.id);
      },
      sendInput: (args, context) => {
        const [input] = z
          .tuple([z.strictObject({ id, message, mode: z.enum(["queue", "steer"]) })])
          .parse(args);
        context.signal.throwIfAborted();
        supervisor.read(input.id);
        const result = supervisor.sendInput({
          id: input.id,
          prompt: input.message,
          mode: input.mode,
        });
        if (!result.ok) throw new Error(result.reason);
        return supervisor.read(input.id);
      },
      interrupt: async (args, context) => {
        const [input] = z.tuple([z.strictObject({ id, wait: z.boolean().optional() })]).parse(args);
        context.signal.throwIfAborted();
        supervisor.read(input.id);
        await supervisor.interrupt(input.id, context.signal, input.wait ?? true);
        return supervisor.read(input.id);
      },
      waitUntilIdle: async (args, context) => {
        const [input] = z.tuple([idOptions]).parse(args);
        await supervisor.waitForAgents([input.id], context.signal);
        return supervisor.read(input.id);
      },
      trace: (args) => {
        const [input] = z.tuple([traceOptions]).parse(args);
        return supervisor.getTrace(input.id).trace(input);
      },
      readContent: (args) => {
        const [input] = z
          .tuple([
            z.strictObject({
              id,
              ref: z.string().min(1).max(256),
              cursor: z.string().max(4096).optional(),
            }),
          ])
          .parse(args);
        return supervisor.getTrace(input.id).readContent(input);
      },
      readText: (args) => {
        const [input] = z
          .tuple([
            z.strictObject({
              id,
              seq: z.number().int().positive(),
              maxChars: z.number().int().min(1).max(100000).optional(),
            }),
          ])
          .parse(args);
        return supervisor.getTrace(input.id).readText(input.seq, input.maxChars);
      },
    },
  };
  for (const [name, handler] of Object.entries(capability.api)) {
    if (typeof handler !== "function") throw new Error("Agent methods must be callable");
    capability.api[name] = async (args, context) => {
      try {
        context.signal.throwIfAborted();
        return await handler(args, context);
      } catch (error) {
        if (error instanceof AgentRequestError) throw error;
        throw new AgentRequestError(
          context.signal.aborted
            ? "cancelled"
            : error instanceof z.ZodError
              ? "invalid_arguments"
              : "operation_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
  }
  return capability;
}
