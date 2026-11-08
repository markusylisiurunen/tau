import { describe, expect, it, vi } from "vitest";
import { createWebCapability } from "../dist/core/code_mode/web.js";
import { discoverAgentContent } from "../dist/core/tools/web_discovery.js";
import { createCapabilityTool } from "./helpers/code_mode.js";

function createExecutionResult(output, exitCode = 0) {
  return {
    output,
    stdout: output,
    stderr: "",
    exitCode,
    truncated: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
  };
}

function createBackend() {
  return {
    runNodeScript: vi.fn(async () => createExecutionResult("", 1)),
    runBash: vi.fn(async () => createExecutionResult("", 1)),
    writeFile: vi.fn(),
  };
}

function createDeps(client) {
  return {
    createExaClient: vi.fn(() => client),
    discover: vi.fn(async (_backend, url) => ({
      requestedUrl: url,
      markdown: [{ url: `${url}.md`, via: "markdown-path", contentType: "text/plain" }],
      llmsTxt: [],
    })),
  };
}

function createWebTool(backend, deps, config = { apiKeys: { exa: "exa-key" } }) {
  return createCapabilityTool(backend, createWebCapability(backend, config, deps), deps);
}

async function runTool(tool, arguments_, signal = new AbortController().signal) {
  const call = { id: "web-1", name: "web", arguments: arguments_ };
  const activities = [];
  const outcome = await tool.execute(call, {
    agentId: "test-agent",
    turnId: "test-turn",
    assistantMessageId: "test-assistant",
    signal,
    emitActivity: async (activity) => activities.push(activity),
  });
  return {
    dispatch: { startedUiEvent: activities[0] },
    result: {
      toolResult: { ...outcome, toolCallId: call.id, toolName: call.name },
      uiEvent: activities.at(-1),
    },
  };
}

function getToolText(result) {
  return result.toolResult.content.find((block) => block.type === "text")?.text ?? "";
}

describe("Exa web code-mode tool", () => {
  it("runs metadata discovery through the execution environment", async () => {
    const requestedUrl = "https://example.com/docs/getting-started";
    const responses = new Map([
      [
        requestedUrl,
        {
          url: requestedUrl,
          status: 200,
          contentType: "text/markdown",
          vary: "Accept",
        },
      ],
      [
        `${requestedUrl}.md`,
        {
          url: `${requestedUrl}.md`,
          status: 200,
          contentType: "text/html",
          vary: "",
        },
      ],
      [
        `${requestedUrl}/index.md`,
        {
          url: `${requestedUrl}/index.md`,
          status: 200,
          contentType: "text/plain",
          vary: "",
        },
      ],
      [
        "https://example.com/llms.txt",
        {
          url: "https://example.com/llms.txt",
          status: 200,
          contentType: "text/plain",
          vary: "",
        },
      ],
      [
        "https://example.com/docs/llms.txt",
        {
          url: "https://example.com/docs/llms.txt",
          status: 404,
          contentType: "text/plain",
          vary: "",
        },
      ],
      [
        "https://example.com/docs/getting-started/llms.txt",
        {
          url: "https://example.com/docs/getting-started/llms.txt",
          status: 200,
          contentType: "text/markdown",
          vary: "",
        },
      ],
    ]);
    const backend = createBackend();
    backend.runNodeScript.mockImplementation(async (script, args, options) => {
      const requests = JSON.parse(args[0]);
      expect(script).toContain("fetch(request.url");
      expect(script).toContain("response.body?.cancel()");
      expect(args[1]).toBe("8000");
      expect(options).toMatchObject({ timeoutMs: 10000, maxCaptureBytes: 256 * 1024 });
      return createExecutionResult(
        JSON.stringify(requests.map((request) => responses.get(request.url) ?? null)),
      );
    });

    const signal = new AbortController().signal;
    const discovered = await discoverAgentContent(backend, requestedUrl, signal);

    expect(discovered).toEqual({
      requestedUrl,
      markdown: [
        {
          url: requestedUrl,
          via: "content-negotiation",
          contentType: "text/markdown",
          varyAccept: true,
        },
        {
          url: `${requestedUrl}/index.md`,
          via: "markdown-path",
          contentType: "text/plain",
        },
      ],
      llmsTxt: [
        {
          url: "https://example.com/llms.txt",
          contentType: "text/plain",
        },
        {
          url: "https://example.com/docs/getting-started/llms.txt",
          contentType: "text/markdown",
        },
      ],
    });
    expect(backend.runNodeScript).toHaveBeenCalledWith(
      expect.any(String),
      [
        JSON.stringify([
          {
            url: requestedUrl,
            accept: "text/markdown, text/plain;q=0.9, text/html;q=0.1",
          },
          {
            url: `${requestedUrl}.md`,
            accept: "text/markdown, text/plain;q=0.9",
            sameOrigin: "https://example.com",
          },
          {
            url: `${requestedUrl}/index.md`,
            accept: "text/markdown, text/plain;q=0.9",
            sameOrigin: "https://example.com",
          },
          {
            url: "https://example.com/llms.txt",
            accept: "text/plain, text/markdown;q=0.9",
            sameOrigin: "https://example.com",
          },
          {
            url: "https://example.com/docs/llms.txt",
            accept: "text/plain, text/markdown;q=0.9",
            sameOrigin: "https://example.com",
          },
          {
            url: "https://example.com/docs/getting-started/llms.txt",
            accept: "text/plain, text/markdown;q=0.9",
            sameOrigin: "https://example.com",
          },
        ]),
        "8000",
      ],
      expect.objectContaining({ signal }),
    );
  });

  it("runs generated code in a capability-limited sandbox", async () => {
    const backend = createBackend();
    const deps = createDeps({});
    const tool = createWebTool(backend, deps);
    const { dispatch, result } = await runTool(tool, {
      code: [
        'printText([typeof process,  typeof fetch,  typeof require,  typeof _requestWeb].join(" "));',
        'printText([typeof Date.now(),  Number.isFinite(new Date().getTime()),  Math.random() >= 0 && Math.random() < 1].join(" "));',
        "const DerivedDate = new Date().constructor;",
        'printText([DerivedDate === Date,  Object.getPrototypeOf(new Date()) === Date.prototype,  typeof DerivedDate(),  new DerivedDate() instanceof Date,  Object.isFrozen(Date),  Object.isFrozen(Date.prototype)].join(" "));',
        "try { printText.constructor('return process')(); } catch { printText('escape blocked'); }",
        "return 'ignored';",
      ].join("\n"),
    });

    expect(dispatch.startedUiEvent).toMatchObject({
      type: "code_mode_started",
      toolName: "code",
    });
    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result)).toContain("undefined undefined undefined undefined");
    expect(getToolText(result)).toContain("number true true");
    expect(getToolText(result)).toContain("true true string true true true");
    expect(getToolText(result)).toContain("escape blocked");
    expect(getToolText(result)).not.toContain("ignored");
    expect(backend.runNodeScript).not.toHaveBeenCalled();
    expect(backend.runBash).not.toHaveBeenCalled();
    expect(deps.createExaClient).not.toHaveBeenCalled();
  });

  it("runs search and fetch through the trusted provider client", async () => {
    const client = {
      search: vi.fn(async (query, options) => ({
        results: [
          {
            title: JSON.stringify({ query, options }),
            url: "https://search.example",
            highlights: ["search highlight"],
            score: 0.9,
          },
        ],
        statuses: [{ id: "https://search.example", status: "success" }],
        costDollars: { total: 1 },
      })),
      getContents: vi.fn(async (urls, options) => ({
        results: [
          {
            title: JSON.stringify({ urls, options }),
            url: urls[0],
            text: "page text",
            image: "https://image.example",
            extras: { links: ["https://linked.example"] },
          },
        ],
        statuses: [{ id: urls[0], status: "success" }],
      })),
    };
    const backend = createBackend();
    const tool = createWebTool(backend, createDeps(client));
    const { result } = await runTool(tool, {
      code: [
        "const search = await tau.web.search('tau', { objective: ' Find official Tau documentation ', numResults: 2, userLocation: 'fi' });",
        "printText(search.results[0].title);",
        "const text = await tau.web.fetch(['https://example.com'], { mode: 'text', maxCharacters: 123, links: 2 });",
        "printText(text.results[0].title);",
        "printText(JSON.stringify(text.results[0]));",
      ].join("\n"),
    });

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.uiEvent.presentation.operation).toBe("code");
    expect(result.uiEvent.presentation.metadata.some((part) => part.startsWith("exit "))).toBe(
      false,
    );
    expect(result.uiEvent.presentation.metadata[0]).toMatch(/^(?:\d+ms|\d+(?:\.\d+)?s)$/);
    expect(result.uiEvent.presentation.metadata[1]).toMatch(/^~\d+ tokens?$/);
    expect(result.uiEvent.presentation.metadata[2]).toMatch(/^\d+ lines?$/);
    expect(client.search).toHaveBeenCalledWith(
      "tau",
      {
        type: "auto",
        objective: "Find official Tau documentation",
        numResults: 2,
        userLocation: "FI",
        contents: { highlights: { dynamic: true } },
      },
      expect.any(AbortSignal),
    );
    expect(client.getContents).toHaveBeenCalledWith(
      ["https://example.com"],
      {
        text: { maxCharacters: 123 },
        extras: { links: 2 },
      },
      expect.any(AbortSignal),
    );
    expect(getToolText(result)).toContain("page text");
    expect(getToolText(result)).toContain("https://linked.example");
    expect(getToolText(result)).not.toContain("costDollars");
    expect(getToolText(result)).not.toContain("image.example");
  });

  it("rejects oversized provider responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    try {
      const backend = createBackend();
      const tool = createWebTool(backend);
      const { result } = await runTool(tool, { code: "await tau.web.search('tau')" });

      expect(result.toolResult.outcome).toBe("failed");
      expect(getToolText(result)).toContain("Exa response exceeded the 16 MiB limit");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("fails when the provider returns an invalid response", async () => {
    const backend = createBackend();
    const tool = createWebTool(backend, createDeps({ search: vi.fn(async () => ({})) }));
    const { result } = await runTool(tool, { code: "await tau.web.search('tau')" });

    expect(result.toolResult.outcome).toBe("failed");
    expect(getToolText(result)).toContain("Invalid Exa response");
  });

  it("supports keyless discovery without constructing a provider client", async () => {
    const backend = createBackend();
    const deps = createDeps({});
    const tool = createWebTool(backend, deps, {});
    const { result } = await runTool(tool, {
      code: [
        "const discovery = await tau.web.discover('https://example.com/docs');",
        "printText(discovery.markdown[0].url);",
      ].join("\n"),
    });

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result)).toContain("https://example.com/docs.md");
    expect(deps.discover).toHaveBeenCalledWith(
      backend,
      "https://example.com/docs",
      expect.any(AbortSignal),
    );
    expect(deps.createExaClient).not.toHaveBeenCalled();
  });

  it("rejects unsupported options and missing credentials", async () => {
    const backend = createBackend();
    const deps = createDeps({});
    const unsupportedTool = createWebTool(backend, deps);
    const unsupported = await runTool(unsupportedTool, {
      code: "await tau.web.search('tau', { stream: true })",
    });
    expect(unsupported.result.toolResult.outcome).toBe("failed");
    expect(getToolText(unsupported.result)).toContain('Unrecognized key: "stream"');

    const missingKeyTool = createWebTool(backend, deps, {});
    const missingKey = await runTool(missingKeyTool, { code: "await tau.web.search('tau')" });
    expect(missingKey.result.toolResult.outcome).toBe("failed");
    expect(getToolText(missingKey.result)).toContain("Missing Exa API key.");
  });

  it("enforces provider request bounds", async () => {
    const client = {
      search: vi.fn(),
      getContents: vi.fn(),
    };
    const backend = createBackend();
    const tool = createWebTool(backend, createDeps(client));
    const { result } = await runTool(tool, {
      code: [
        "const calls = [",
        "  () => tau.web.search('tau', { maxAgeHours: 721 }),",
        "  () => tau.web.fetch(Array.from({ length: 101 }, (_, index) => 'https://example.com/' + index)),",
        "  () => tau.web.fetch('https://example.com', { maxCharacters: 10001, maxAgeHours: 721, subpages: 101, subpageTarget: Array(101).fill('docs'), links: 1001 }),",
        "];",
        "for (const call of calls) {",
        "  try { await call(); } catch (error) { printText(error.message); }",
        "}",
      ].join("\n"),
    });

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result)).toContain("Invalid tau.web.search options");
    expect(getToolText(result)).toContain("Invalid tau.web.fetch urls");
    expect(getToolText(result)).toContain("maxCharacters");
    expect(getToolText(result)).toContain("maxAgeHours");
    expect(getToolText(result)).toContain("subpages");
    expect(getToolText(result)).toContain("subpageTarget");
    expect(getToolText(result)).toContain("links");
    expect(client.search).not.toHaveBeenCalled();
    expect(client.getContents).not.toHaveBeenCalled();
  });

  it("cancels and settles provider requests before returning", async () => {
    let markProviderStarted;
    const providerStarted = new Promise((resolve) => {
      markProviderStarted = resolve;
    });
    let providerSettled = false;
    const client = {
      search: vi.fn(
        async (_query, _options, signal) =>
          await new Promise((_resolve, reject) => {
            markProviderStarted();
            signal.addEventListener(
              "abort",
              () => {
                providerSettled = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ),
    };
    const backend = createBackend();
    const tool = createWebTool(backend, createDeps(client));
    const controller = new AbortController();
    const run = runTool(tool, { code: "await tau.web.search('tau')" }, controller.signal);

    await providerStarted;
    controller.abort();
    const { result } = await run;

    expect(providerSettled).toBe(true);
    expect(client.search.mock.calls[0][2].aborted).toBe(true);
    expect(getToolText(result)).toBe("Program was cancelled.");
  });
});
