// Shared helpers for every workflow.

import {
  launchOptions,
  readResponse,
  sendInput,
  spawn,
  waitUntilIdle,
} from "@tau/agents";
import { run as runCommand } from "@tau/bash";
import { printText, truncate } from "@tau/core";
import { chat } from "@tau/models";

const PARSE_MODEL = "openai/gpt-6-luna";
const PARALLEL_REQUESTS = 8;

// 196,608 bytes, safely below Tau's 262,144-character subagent prompt limit.
const MAX_PROMPT_TOKENS = 32_768;

export async function preflightModels(models) {
  const { overrides } = await launchOptions();
  const allowed = new Set(overrides.map(({ model }) => model));
  const missing = [...new Set(models)].filter((model) => !allowed.has(model));
  ensure(
    !missing.length,
    `Missing subagent launch choices:\n${missing.map((model) => `- ${model}`).join("\n")}`,
  );
}

// A run owns the temporary folder for intermediate results, tracks the total
// cost and any warnings, and prints the final result.
export async function startRun({ prefix, workingDirectory }) {
  const folder = (
    await bash(`tmp="\${TMPDIR:-/tmp}"; mktemp -d "\${tmp%/}/${prefix}.XXXXXX"`)
  ).trim();
  log(`Run folder: ${folder}`);
  log(`Agent responses are parsed with ${PARSE_MODEL} at low reasoning`);

  const run = {
    folder,
    started: Date.now(),
    cost: 0,
    warnings: [],
    // Each agent's usage is cumulative, so a follow-up turn costs the
    // difference from what the agent had cost before it.
    agentCosts: new Map(),
    step: async (options) =>
      (await runStep(run, workingDirectory, options)).result,
    // Like step, but also returns the agent ID, so a later turn can continue
    // the same agent by passing it as `agentId`.
    turn: (options) => runStep(run, workingDirectory, options),
    stepsInParallel: (steps) =>
      runStepsInParallel(run, workingDirectory, steps),
    save: (file, text) => save(folder, file, text),
    // Every done or failed line adds the step's cost and shows the total so
    // far, so the log always ends with the current total.
    done(name, started, cost, summary) {
      run.cost += cost;
      logEnd("done", name, started, cost, run.cost, summary);
    },
    failed(name, started, cost, message) {
      run.cost += cost;
      logEnd("failed", name, started, cost, run.cost, message);
    },
    warn(message) {
      run.warnings.push(message);
      log(`Warning: ${message}`);
    },
    finish(result) {
      log(
        `Finished in ${elapsed(run.started)}, total $${run.cost.toFixed(2)}, warnings=${run.warnings.length}`,
      );
      const warnings = run.warnings.length
        ? `## Warnings\n\n${run.warnings.map((warning) => `- ${warning}`).join("\n")}\n\n`
        : "";
      printText(`\n${warnings}${result}`);
    },
  };
  return run;
}

// Run one agent turn, parse the JSON in its response, and save the prompt and
// the result, as JSON and as formatted Markdown. Without `agentId` the turn
// starts a new agent, and with it the turn continues that agent. A turn
// without `output` returns no result, such as one that only prepares the
// agent for a later turn.
async function runStep(
  run,
  workingDirectory,
  { name, model, prompt, output, agentId: existing },
) {
  const started = Date.now();
  let agentId = existing ?? "not started";
  let cost = 0;
  try {
    await run.save(`${name}.prompt.md`, prompt);
    ensure(
      tokens(prompt) <= MAX_PROMPT_TOKENS,
      `prompt of ${tokens(prompt)} tokens exceeds the limit of ${MAX_PROMPT_TOKENS}`,
    );
    if (existing) {
      const agent = await sendInput(existing, prompt, { mode: "queue" });
      logStart(name, agent.model, `agent ${existing}`);
    } else {
      const agent = await spawn(prompt, {
        title: name,
        model,
        workingDirectory,
        notifyOnCompletion: false,
      });
      agentId = agent.id;
      logStart(name, model, `agent ${agent.id}`);
    }

    const state = await waitUntilIdle(agentId);
    cost += state.usage.cost - (run.agentCosts.get(agentId) ?? 0);
    run.agentCosts.set(agentId, state.usage.cost);
    ensure(
      state.reason === "completed",
      state.error?.message ?? `turn ${state.reason ?? state.status}`,
    );
    if (!output) {
      run.done(name, started, cost, "");
      return { agentId, result: undefined };
    }
    const response = await readResponse(agentId);
    const parsed = await parse(response, output.schema);
    cost += parsed.cost;

    await run.save(`${name}.json`, JSON.stringify(parsed.result, null, 2));
    await run.save(`${name}.md`, output.format(parsed.result));
    run.done(name, started, cost, output.summary(parsed.result));
    return { agentId, result: parsed.result };
  } catch (error) {
    run.failed(name, started, cost, `${error.message} (agent ${agentId})`);
    throw error;
  }
}

// Run steps in parallel. A failed step does not stop the others.
async function runStepsInParallel(run, workingDirectory, steps) {
  const outcomes = await Promise.all(
    steps.map((step) =>
      runStep(run, workingDirectory, step).then(
        ({ result }) => ({ name: step.name, result }),
        () => ({ name: step.name, failed: true }),
      ),
    ),
  );
  return {
    completed: outcomes.filter((outcome) => !outcome.failed),
    failed: outcomes
      .filter((outcome) => outcome.failed)
      .map((outcome) => outcome.name),
  };
}

// Agent output is not schema-constrained, so the JSON may be fenced or
// surrounded by prose. The parser can report that it found no single value
// instead of inventing one.
async function parse(response, schema) {
  const parsed = await chat(
    `The agent response below should contain one JSON value. Your only task is to extract that value into result. The value can appear anywhere in the response, surrounded by prose or wrapped in a code fence. Copy every value exactly, without adding, dropping, merging, or rewording anything, and do not judge the content.

Set complete to false only if you cannot identify one unambiguous JSON value, for example because it is missing, cut off, or the response contains several different ones. In that case, set result to null and explain in reason what prevented extraction. Otherwise, set complete to true and reason to null.

Response:
${response}`,
    {
      model: PARSE_MODEL,
      reasoning: "low",
      schema: object({
        complete: { type: "boolean" },
        reason: { type: ["string", "null"] },
        result: { anyOf: [schema, { type: "null" }] },
      }),
    },
  );
  ensure(parsed.status === "complete", `parsing ended as ${parsed.status}`);
  ensure(
    parsed.answer.complete && parsed.answer.result,
    `no JSON response: ${parsed.answer.reason ?? "no reason given"}`,
  );
  return { result: parsed.answer.result, cost: parsed.usage?.cost ?? 0 };
}

// The response shape as a TypeScript-like type with descriptions as
// comments, which reads far shorter than the JSON Schema. The parser still
// checks the response against the schema itself.
export function responseFormat(output) {
  const optional = hasOptional(output.schema);
  return `## Response

End with your final response as one JSON value of this type. ${optional ? "Fields marked `?` are optional, every other field is required, and no others are allowed." : "Every field is required, and no others are allowed."}

\`\`\`ts
${typeText(output.schema, "")}
\`\`\``;
}

function typeText(schema, indent) {
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.anyOf) {
    return schema.anyOf.map((s) => typeText(s, indent)).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((type) => typeText({ ...schema, type }, indent))
      .join(" | ");
  }
  if (schema.type === "array") {
    const item = typeText(schema.items, indent);
    return schema.items.type === "object" || schema.items.enum
      ? `Array<${item}>`
      : `${item}[]`;
  }
  if (schema.type !== "object") return schema.type;
  const inner = `${indent}  `;
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(schema.properties).flatMap(
    ([name, property]) => [
      ...(property.description ? [`${inner}// ${property.description}`] : []),
      `${inner}${name}${required.has(name) ? "" : "?"}: ${typeText(property, inner)};`,
    ],
  );
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function hasOptional(schema) {
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? []);
    if (
      Object.keys(schema.properties ?? {}).some((name) => !required.has(name))
    ) {
      return true;
    }
  }
  return [
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
    ...(schema.anyOf ?? []),
  ].some(hasOptional);
}

// A JSON Schema object whose properties are all required.
export function object(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

// Run fn over items with a bounded number of calls in flight.
export async function inParallel(items, fn, concurrency = PARALLEL_REQUESTS) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export async function bash(command, workingDirectory) {
  const result = await runCommand(command, { workingDirectory });
  ensure(result.exitCode === 0, `Command failed: ${command}\n${result.stderr}`);
  return result.stdout;
}

async function save(folder, file, text) {
  const result = await runCommand(`cat > ${file}`, {
    stdin: text,
    workingDirectory: folder,
  });
  ensure(result.exitCode === 0, `Could not save ${file}: ${result.stderr}`);
}

export function log(message) {
  printText(`${new Date().toTimeString().slice(0, 8)}  ${message}`);
}

export function logStart(name, model, detail) {
  log(`start   ${name.padEnd(20)} ${model.padEnd(34)} ${detail}`);
}

// The first line of the summary goes on the status line. Any further lines
// are details, indented under the step name and kept short enough to scan.
function logEnd(status, name, started, cost, total, summary) {
  const [first, ...details] = summary.split("\n");
  log(
    `${status.padEnd(7)} ${name.padEnd(20)} ${elapsed(started).padEnd(7)} $${cost.toFixed(2).padEnd(6)} total $${total.toFixed(2).padEnd(6)} ${first}`,
  );
  for (const detail of details) {
    printText(`${" ".repeat(18)}${truncate(detail, { maxChars: 512 })}`);
  }
}

// Collapse Markdown text to one line for a log detail, without list markers.
export function oneLine(text) {
  return text
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function elapsed(started) {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function byteLength(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Tau estimates one token per six bytes of UTF-8.
export function tokens(text) {
  return Math.ceil(byteLength(text) / 6);
}

// Cut text to at most `maxTokens` tokens, marking the cut.
export function truncateTokens(text, maxTokens) {
  const maxBytes = maxTokens * 6;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += byteLength(char);
    if (bytes > maxBytes) return `${text.slice(0, end)} [cut]`;
    end += char.length;
  }
  return text;
}

export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
