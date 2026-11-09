// Shared helpers for every workflow, exposed as globalThis.workflow.

globalThis.workflow = (() => {
  const PARSE_MODEL = "openai/gpt-6-luna";
  const PARALLEL_REQUESTS = 8;

  // 196,608 bytes, safely below Tau's 262,144-character subagent prompt limit.
  const MAX_PROMPT_TOKENS = 32_768;

  // A run owns the temporary folder for intermediate results, tracks the total
  // cost and any warnings, and prints the final result.
  async function startRun({ prefix, workingDirectory }) {
    const folder = (
      await bash(
        `tmp="\${TMPDIR:-/tmp}"; mktemp -d "\${tmp%/}/${prefix}.XXXXXX"`,
      )
    ).trim();
    log(`Run folder: ${folder}`);
    log(`Agent responses are parsed with ${PARSE_MODEL} at low reasoning`);

    const run = {
      started: Date.now(),
      cost: 0,
      warnings: [],
      step: (options) => runStep(run, workingDirectory, options),
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

  // Run one agent, parse the JSON in its response, and save the prompt and the
  // result, as JSON and as formatted Markdown.
  async function runStep(
    run,
    workingDirectory,
    { name, model, prompt, output },
  ) {
    const started = Date.now();
    let agentId = "not started";
    let cost = 0;
    try {
      await run.save(`${name}.prompt.md`, prompt);
      ensure(
        tokens(prompt) <= MAX_PROMPT_TOKENS,
        `prompt of ${tokens(prompt)} tokens exceeds the limit of ${MAX_PROMPT_TOKENS}`,
      );
      const agent = await tau.agents.spawn({
        title: name,
        prompt,
        model,
        workingDirectory,
      });
      agentId = agent.id;
      logStart(name, model, `agent ${agent.id}`);

      const state = await tau.agents.waitUntilIdle({ id: agent.id });
      cost += state.usage.cost;
      ensure(
        state.reason === "completed",
        state.error?.message ?? `turn ${state.reason ?? state.status}`,
      );
      const response = await lastResponse(agent.id);
      const parsed = await parse(response, output.schema);
      cost += parsed.cost;

      await run.save(`${name}.json`, JSON.stringify(parsed.result, null, 2));
      await run.save(`${name}.md`, output.format(parsed.result));
      run.done(name, started, cost, output.summary(parsed.result));
      return parsed.result;
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
          (result) => ({ name: step.name, result }),
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

  async function lastResponse(agentId) {
    const trace = await tau.agents.trace({
      id: agentId,
      kinds: ["assistant"],
      limit: 1,
    });
    ensure(trace.entries[0], "no response");
    const response = await tau.agents.readText({
      id: agentId,
      seq: trace.entries[0].seq,
      maxChars: 100_000, // Tau's maximum
    });
    ensure(response.complete, "response too long to read");
    return response.text;
  }

  // Agent output is not schema-constrained, so the JSON may be fenced or
  // surrounded by prose. The parser can report that it found no single value
  // instead of inventing one.
  async function parse(response, schema) {
    const parsed = await tau.models.chat({
      model: PARSE_MODEL,
      reasoning: "low",
      schema: object({
        complete: { type: "boolean" },
        reason: { type: ["string", "null"] },
        result: { anyOf: [schema, { type: "null" }] },
      }),
      prompt: `The agent response below should contain one JSON value. Your only task is to extract that value into result. The value can appear anywhere in the response, surrounded by prose or wrapped in a code fence. Copy every value exactly, without adding, dropping, merging, or rewording anything, and do not judge the content.

Set complete to false only if you cannot identify one unambiguous JSON value, for example because it is missing, cut off, or the response contains several different ones. In that case, set result to null and explain in reason what prevented extraction. Otherwise, set complete to true and reason to null.

Response:
${response}`,
    });
    ensure(
      parsed.finish_reason === "stop" && !parsed.refusal,
      "parsing did not complete",
    );
    ensure(
      parsed.answer.complete && parsed.answer.result,
      `no JSON response: ${parsed.answer.reason ?? "no reason given"}`,
    );
    return { result: parsed.answer.result, cost: parsed.usage?.cost ?? 0 };
  }

  function responseFormat(output) {
    return `## Response

End with your final response as one JSON value that matches this JSON Schema:

\`\`\`json
${JSON.stringify(output.schema, null, 2)}
\`\`\``;
  }

  // A JSON Schema object whose properties are all required.
  function object(properties) {
    return {
      type: "object",
      additionalProperties: false,
      required: Object.keys(properties),
      properties,
    };
  }

  // Run fn over items with a bounded number of calls in flight.
  async function inParallel(items, fn) {
    const results = [];
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }
    await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker));
    return results;
  }

  async function bash(command, workingDirectory) {
    const result = await tau.bash.run({ command, workingDirectory });
    ensure(
      result.exitCode === 0,
      `Command failed: ${command}\n${result.stderr}`,
    );
    return result.stdout;
  }

  async function save(folder, file, text) {
    const result = await tau.bash.run({
      command: `cat > ${file}`,
      stdin: text,
      workingDirectory: folder,
    });
    ensure(result.exitCode === 0, `Could not save ${file}: ${result.stderr}`);
  }

  function log(message) {
    printText(`${new Date().toTimeString().slice(0, 8)}  ${message}`);
  }

  function logStart(name, model, detail) {
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
  function oneLine(text) {
    return text
      .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function elapsed(started) {
    const seconds = Math.round((Date.now() - started) / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  }

  // Tau estimates one token per six bytes of UTF-8.
  function tokens(text) {
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return Math.ceil(bytes / 6);
  }

  function ensure(condition, message) {
    if (!condition) throw new Error(message);
  }

  return {
    startRun,
    responseFormat,
    object,
    inParallel,
    bash,
    log,
    logStart,
    oneLine,
    tokens,
    ensure,
  };
})();
