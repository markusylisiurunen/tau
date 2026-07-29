import { describe, expect, it, vi } from "vitest";
import { getExaApiKey } from "../dist/core/config/index.js";
import { createWebToolDefinition } from "../dist/core/tools/web.js";
import { assertPublicWebUrl, discoverAgentContent } from "../dist/core/tools/web_discovery.js";

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
    discover: vi.fn(async (url) => ({
      requestedUrl: url,
      markdown: [{ url: `${url}.md`, via: "markdown-path", contentType: "text/plain" }],
      llmsTxt: [],
    })),
  };
}

async function runTool(
  tool,
  arguments_,
  context = { scope: "subagent", cwd: "/project", config: { apiKeys: { exa: "exa-key" } } },
  signal = new AbortController().signal,
) {
  const dispatch = await tool.dispatch(
    { id: "web-1", name: "web", arguments: arguments_ },
    signal,
    context,
  );
  return { dispatch, result: await dispatch.run };
}

function getToolText(result) {
  return result.toolResult.content.find((block) => block.type === "text")?.text ?? "";
}

describe("Exa web code-mode tool", () => {
  it("resolves the Exa API key from the environment before config", () => {
    expect(getExaApiKey({ apiKeys: { exa: "config-key" } }, { EXA_API_KEY: " env-key " })).toBe(
      "env-key",
    );
    expect(getExaApiKey({ apiKeys: { exa: " config-key " } }, {})).toBe("config-key");
  });

  it("bundles documentation for only the bounded web API", () => {
    const backend = createBackend();
    const tool = createWebToolDefinition(backend, createDeps({}));

    expect(tool.schema.description).toContain("use web.discover first");
    expect(tool.schema.description).toContain("receives web, docs, and console globals");
  });

  it("discovers only metadata for deterministic Markdown and llms.txt responses", async () => {
    const requestedUrl = "https://example.com/docs/getting-started";
    const responses = new Map([
      [
        requestedUrl,
        {
          status: 200,
          contentType: "text/markdown",
          vary: "Accept",
          body: "# Negotiated content that must not be returned",
        },
      ],
      [
        `${requestedUrl}.md`,
        {
          status: 200,
          contentType: "text/html",
          vary: "",
          body: "<html>fallback</html>",
        },
      ],
      [
        `${requestedUrl}/index.md`,
        {
          status: 200,
          contentType: "text/plain",
          vary: "",
          body: "# Explicit Markdown content that must not be returned",
        },
      ],
      [
        "https://example.com/llms.txt",
        {
          status: 200,
          contentType: "text/plain",
          vary: "",
          body: "# Example docs\n- [Getting started](/docs/getting-started/index.md)",
        },
      ],
      [
        "https://example.com/docs/llms.txt",
        {
          status: 404,
          contentType: "text/plain",
          vary: "",
          body: "not found",
        },
      ],
    ]);
    const calls = [];
    const request = vi.fn(async (url, options) => {
      calls.push({ url: url.toString(), accept: options.accept });
      const response = responses.get(url.toString());
      if (!response) throw new Error("unexpected URL");
      return { url: url.toString(), ...response };
    });

    const discovered = await discoverAgentContent(requestedUrl, {
      request,
      validate: async (value) => new URL(value),
    });

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
      ],
    });
    expect(JSON.stringify(discovered)).not.toContain("must not be returned");
    expect(JSON.stringify(discovered)).not.toContain("Getting started");
    expect(calls.map((call) => call.url)).toEqual([
      requestedUrl,
      `${requestedUrl}.md`,
      `${requestedUrl}/index.md`,
      "https://example.com/llms.txt",
      "https://example.com/docs/llms.txt",
    ]);
  });

  it("allows public discovery targets and rejects private targets", async () => {
    await expect(assertPublicWebUrl("https://8.8.8.8/docs")).resolves.toMatchObject({
      hostname: "8.8.8.8",
    });
    await expect(assertPublicWebUrl("http://127.0.0.1/docs")).rejects.toThrow(
      "only supports public web addresses",
    );
    await expect(assertPublicWebUrl("http://[::ffff:127.0.0.1]/docs")).rejects.toThrow(
      "only supports public web addresses",
    );
  });

  it("runs generated code in a capability-limited sandbox", async () => {
    const backend = createBackend();
    const deps = createDeps({});
    const tool = createWebToolDefinition(backend, deps);
    const { dispatch, result } = await runTool(tool, {
      code: [
        "console.log(typeof process, typeof fetch, typeof require, typeof _requestWeb);",
        "try { console.log.constructor('return process')(); } catch { console.log('escape blocked'); }",
        "return 'ignored';",
      ].join("\n"),
    });

    expect(dispatch.startedUiEvent).toMatchObject({
      type: "code_mode_started",
      toolName: "web",
      label: "web",
    });
    expect(result.toolResult.isError).toBe(false);
    expect(getToolText(result)).toContain("undefined undefined undefined undefined");
    expect(getToolText(result)).toContain("escape blocked");
    expect(getToolText(result)).not.toContain("ignored");
    expect(backend.runNodeScript).not.toHaveBeenCalled();
    expect(backend.runBash).not.toHaveBeenCalled();
    expect(deps.createExaClient).toHaveBeenCalledWith("exa-key");
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
    const tool = createWebToolDefinition(backend, createDeps(client));
    const { result } = await runTool(tool, {
      code: [
        "const search = await web.search('tau', { numResults: 2, userLocation: 'fi' });",
        "console.log(search.results[0].title);",
        "const text = await web.fetch(['https://example.com'], { mode: 'text', maxCharacters: 123, links: 2 });",
        "console.log(text.results[0].title);",
        "console.log(JSON.stringify(text.results[0]));",
      ].join("\n"),
    });

    expect(result.toolResult.isError).toBe(false);
    expect(client.search).toHaveBeenCalledWith("tau", {
      type: "auto",
      numResults: 2,
      userLocation: "FI",
      contents: { highlights: true },
    });
    expect(client.getContents).toHaveBeenCalledWith(["https://example.com"], {
      text: { maxCharacters: 123 },
      extras: { links: 2 },
    });
    expect(getToolText(result)).toContain("page text");
    expect(getToolText(result)).toContain("https://linked.example");
    expect(getToolText(result)).not.toContain("costDollars");
    expect(getToolText(result)).not.toContain("image.example");
  });

  it("supports keyless documentation and discovery without constructing a provider client", async () => {
    const backend = createBackend();
    const deps = createDeps({});
    const tool = createWebToolDefinition(backend, deps);
    const { result } = await runTool(
      tool,
      {
        code: [
          "console.log(docs.includes('web.discover(url)'));",
          "const discovery = await web.discover('https://example.com/docs');",
          "console.log(discovery.markdown[0].url);",
        ].join("\n"),
      },
      { scope: "main", cwd: "/project", config: {} },
    );

    expect(result.toolResult.isError).toBe(false);
    expect(getToolText(result)).toContain("true");
    expect(getToolText(result)).toContain("https://example.com/docs.md");
    expect(deps.discover).toHaveBeenCalledWith("https://example.com/docs");
    expect(deps.createExaClient).not.toHaveBeenCalled();
  });

  it("rejects unsupported options and missing credentials", async () => {
    const backend = createBackend();
    const deps = createDeps({});
    const tool = createWebToolDefinition(backend, deps);
    const unsupported = await runTool(tool, {
      code: "await web.search('tau', { stream: true })",
    });
    expect(unsupported.result.toolResult.isError).toBe(true);
    expect(getToolText(unsupported.result)).toContain("does not support option 'stream'");

    const missingKey = await runTool(
      tool,
      { code: "await web.search('tau')" },
      { scope: "main", cwd: "/project", config: {} },
    );
    expect(missingKey.result.toolResult.isError).toBe(true);
    expect(getToolText(missingKey.result)).toContain("Missing Exa API key.");
  });

  it("rejects unknown tool arguments without starting the sandbox", async () => {
    const backend = createBackend();
    const deps = createDeps({});
    const tool = createWebToolDefinition(backend, deps);
    const { result } = await runTool(tool, {
      code: "console.log(docs)",
      objective: "legacy shape",
    });

    expect(result.toolResult.isError).toBe(true);
    expect(getToolText(result)).toContain("Invalid arguments");
    expect(deps.createExaClient).not.toHaveBeenCalled();
  });

  it("forwards cancellation to a running sandbox", async () => {
    const backend = createBackend();
    const tool = createWebToolDefinition(backend, createDeps({}));
    const controller = new AbortController();
    const run = runTool(
      tool,
      { code: "for (;;) {}" },
      { scope: "main", cwd: "/project", config: {} },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);

    const { result } = await run;
    expect(result.toolResult.isError).toBe(true);
  });

  it("middle-truncates large program output at 8,192 estimated tokens", async () => {
    const backend = createBackend();
    const tool = createWebToolDefinition(backend, createDeps({}));
    const { result } = await runTool(tool, { code: "console.log('x'.repeat(60_000))" });

    expect(getToolText(result)).toContain("Output truncated for context");
  });
});
