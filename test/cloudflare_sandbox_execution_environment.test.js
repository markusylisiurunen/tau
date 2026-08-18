import { describe, expect, it } from "vitest";
import { personas } from "../dist/core/personas.js";
import {
  CloudflareSandboxBridgeClient,
  CloudflareSandboxExecutionEnvironment,
  createCloudflareSandboxToolExecutionBackend,
} from "../dist/execution/cloudflare_sandbox_execution_environment.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function execSse({ stdout = "", stderr = "", exitCode = 0 }) {
  const chunks = [];
  if (stdout) {
    chunks.push(`event: stdout\ndata: ${Buffer.from(stdout, "utf-8").toString("base64")}\n\n`);
  }
  if (stderr) {
    chunks.push(`event: stderr\ndata: ${Buffer.from(stderr, "utf-8").toString("base64")}\n\n`);
  }
  chunks.push(`event: exit\ndata: ${JSON.stringify({ exit_code: exitCode })}\n\n`);
  return chunks;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for condition");
}

describe("Cloudflare Sandbox execution environment", () => {
  it("runs bash through the bridge exec route with an adapter-owned command session", async () => {
    const requests = [];
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        return sseResponse(execSse({ stdout: "hello\n", exitCode: 0 }));
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      apiKey: "secret",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });
    const environment = new CloudflareSandboxExecutionEnvironment({
      bridgeId: "default",
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
      home: "/home/sandbox",
      backend,
    });

    await expect(
      environment.getToolExecutionBackend().runBash("echo hello", {
        args: ["arg-zero", "arg-one"],
      }),
    ).resolves.toEqual({
      output: "hello\n",
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      truncated: false,
      timedOut: false,
      aborted: false,
      closeSignal: null,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("https://bridge.example/v1/sandbox/sandbox-1/session");
    expect(JSON.parse(requests[0].init.body)).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      cwd: "/workspace/repo",
    });
    expect(requests[1].url).toBe("https://bridge.example/v1/sandbox/sandbox-1/exec");
    expect(requests[1].init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer secret",
        "Session-Id": "tau-session-1",
      }),
    );
    expect(JSON.parse(requests[1].init.body)).toEqual({
      argv: [
        "env",
        "HOME=/home/sandbox",
        "NO_COLOR=1",
        "FORCE_COLOR=0",
        "TERM=dumb",
        "PAGER=cat",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_EDITOR=true",
        "GIT_SEQUENCE_EDITOR=true",
        "GIT_PAGER=cat",
        "GIT_ASKPASS=true",
        "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
        "bash",
        "-lc",
        expect.stringMatching(/\necho hello$/),
        "arg-zero",
        "arg-one",
      ],
      cwd: "/workspace/repo",
    });
  });

  it("preserves UTF-8 characters split across bridge output events", async () => {
    const character = Buffer.from("€", "utf-8");
    const fetchMock = async (url) => {
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        return sseResponse([
          `event: stdout\ndata: ${character.subarray(0, 1).toString("base64")}\n\n`,
          `event: stdout\ndata: ${character.subarray(1).toString("base64")}\n\n`,
          `event: exit\ndata: ${JSON.stringify({ exit_code: 0 })}\n\n`,
        ]);
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await expect(backend.runBash("printf €")).resolves.toMatchObject({
      output: "€",
      stdout: "€",
      stderr: "",
      truncated: false,
    });
  });

  it("stages exec stdin through bridge file operations", async () => {
    const requests = [];
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (init.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        return sseResponse(execSse({ stdout: "input", exitCode: 0 }));
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };
    const backend = createCloudflareSandboxToolExecutionBackend({
      client: new CloudflareSandboxBridgeClient({
        bridgeId: "default",
        baseUrl: "https://bridge.example",
        fetch: fetchMock,
      }),
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await expect(backend.runBash("cat", { stdin: Buffer.from("input") })).resolves.toMatchObject({
      stdout: "input",
    });

    const writeRequest = requests.find((request) => request.init.method === "PUT");
    expect(Buffer.from(writeRequest.init.body)).toEqual(Buffer.from("input"));
    const execRequests = requests.filter((request) => request.url.endsWith("/exec"));
    const command = JSON.parse(execRequests[0].init.body);
    const stdinPath = command.argv.find((argument) => /^\/tmp\/tau-exec-.*\.stdin$/.test(argument));
    expect(stdinPath).toBeDefined();
    expect(command.argv).toEqual([
      "env",
      "NO_COLOR=1",
      "FORCE_COLOR=0",
      "TERM=dumb",
      "PAGER=cat",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_EDITOR=true",
      "GIT_SEQUENCE_EDITOR=true",
      "GIT_PAGER=cat",
      "GIT_ASKPASS=true",
      "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
      "bash",
      "-c",
      'exec "$@" < "$0"',
      stdinPath,
      "bash",
      "-lc",
      expect.stringMatching(/\ncat$/),
    ]);
    expect(JSON.parse(execRequests[1].init.body).argv).toEqual(["rm", "-f", "--", stdinPath]);
  });

  it("writes binary files without text conversion", async () => {
    const requests = [];
    const content = Buffer.from([0, 255, 1]);
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        return sseResponse(execSse({ exitCode: 0 }));
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/file/workspace/repo/assets/image.bin")) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await expect(
      backend.writeFileBinary("/workspace/repo/assets/image.bin", content),
    ).resolves.toEqual({
      path: "/workspace/repo/assets/image.bin",
      bytes: 3,
    });

    expect(requests[2].init.method).toBe("PUT");
    expect(Buffer.from(requests[2].init.body)).toEqual(content);
  });

  it("stops reading binary files when they exceed the requested limit", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(8));
        controller.enqueue(Buffer.alloc(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: async () => new Response(body),
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await expect(
      backend.readFileBinary("/workspace/repo/large.bin", { maxBytes: 10 }),
    ).rejects.toThrow("file exceeds maximum size of 10 B (got 16 B)");
    expect(cancelled).toBe(true);
  });

  it("cancels binary responses whose content length exceeds the requested limit", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: async () =>
        new Response(body, {
          headers: { "Content-Length": "16" },
        }),
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await expect(
      backend.readFileBinary("/workspace/repo/large.bin", { maxBytes: 10 }),
    ).rejects.toThrow("file exceeds maximum size of 10 B (got 16 B)");
    expect(cancelled).toBe(true);
  });

  it("normalizes missing binary files at the backend boundary", async () => {
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: async () => jsonResponse({ error: "file not found" }, { status: 404 }),
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await expect(backend.readFileBinary("/workspace/repo/missing.png")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("serializes bridge exec calls that share a command session", async () => {
    const encoder = new TextEncoder();
    const requests = [];
    const execStreams = [];
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        const stream = {};
        const body = new ReadableStream({
          start(controller) {
            stream.controller = controller;
          },
        });
        execStreams.push(stream);
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    const first = backend.runBash("one");
    await waitFor(() => execStreams.length === 1);
    const second = backend.runBash("two");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(execStreams).toHaveLength(1);
    execStreams[0].controller.enqueue(encoder.encode(execSse({ stdout: "one\n" }).join("")));
    execStreams[0].controller.close();
    await expect(first).resolves.toMatchObject({ output: "one\n" });

    await waitFor(() => execStreams.length === 2);
    execStreams[1].controller.enqueue(encoder.encode(execSse({ stdout: "two\n" }).join("")));
    execStreams[1].controller.close();
    await expect(second).resolves.toMatchObject({ output: "two\n" });

    const sessionRequests = requests.filter((request) => request.url.endsWith("/session"));
    expect(sessionRequests).toHaveLength(1);
  });

  it("cancels a queued command before it reaches the bridge", async () => {
    const encoder = new TextEncoder();
    const execStreams = [];
    const fetchMock = async (url) => {
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        const stream = {};
        const body = new ReadableStream({
          start(controller) {
            stream.controller = controller;
          },
        });
        execStreams.push(stream);
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return jsonResponse({});
    };
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    const first = backend.runBash("one");
    await waitFor(() => execStreams.length === 1);
    const controller = new AbortController();
    const second = backend.runBash("two", { signal: controller.signal });
    controller.abort();

    await expect(second).resolves.toMatchObject({ aborted: true, exitCode: null });
    expect(execStreams).toHaveLength(1);
    execStreams[0].controller.enqueue(encoder.encode(execSse({ stdout: "one\n" }).join("")));
    execStreams[0].controller.close();
    await expect(first).resolves.toMatchObject({ output: "one\n" });
    await backend.dispose();
  });

  it("cancels active and queued commands, awaits cleanup, and rejects new work on dispose", async () => {
    const requests = [];
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    let execCount = 0;
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        execCount += 1;
        const body = new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
              once: true,
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (String(url).includes("/v1/sandbox/sandbox-1/session/tau-session-1")) {
        deleteStarted.resolve();
        await releaseDelete.promise;
        return jsonResponse({});
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    const first = backend.runBash("one");
    await waitFor(() => execCount === 1);
    const second = backend.runBash("two");
    const firstResult = expect(first).resolves.toMatchObject({ aborted: true, exitCode: null });
    const secondResult = expect(second).resolves.toMatchObject({ aborted: true, exitCode: null });

    let disposed = false;
    const disposal = backend.dispose().then(() => {
      disposed = true;
    });
    await deleteStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    releaseDelete.resolve();
    await disposal;
    await firstResult;
    await secondResult;
    expect(execCount).toBe(1);
    await expect(backend.runBash("three")).rejects.toThrow("backend is disposed");
    expect(requests.filter((request) => request.url.endsWith("/exec"))).toHaveLength(1);
  });

  it("serializes node scripts with bash commands that share a command session", async () => {
    const encoder = new TextEncoder();
    const requests = [];
    const execStreams = [];
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        const stream = {};
        const body = new ReadableStream({
          start(controller) {
            stream.controller = controller;
          },
        });
        execStreams.push(stream);
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    const bashRun = backend.runBash("one");
    await waitFor(() => execStreams.length === 1);
    const scriptRun = backend.runNodeScript("process.stdout.write(process.argv[1])", ["two"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(execStreams).toHaveLength(1);
    execStreams[0].controller.enqueue(encoder.encode(execSse({ stdout: "one\n" }).join("")));
    execStreams[0].controller.close();
    await expect(bashRun).resolves.toMatchObject({ output: "one\n" });

    await waitFor(() => execStreams.length === 2);
    execStreams[1].controller.enqueue(encoder.encode(execSse({ stdout: "two" }).join("")));
    execStreams[1].controller.close();
    await expect(scriptRun).resolves.toMatchObject({ output: "two" });

    const execRequests = requests.filter((request) => request.url.endsWith("/exec"));
    expect(execRequests.map((request) => JSON.parse(request.init.body).argv)).toEqual([
      [
        "env",
        "NO_COLOR=1",
        "FORCE_COLOR=0",
        "TERM=dumb",
        "PAGER=cat",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_EDITOR=true",
        "GIT_SEQUENCE_EDITOR=true",
        "GIT_PAGER=cat",
        "GIT_ASKPASS=true",
        "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
        "bash",
        "-lc",
        expect.stringMatching(/\none$/),
      ],
      [
        "env",
        "NO_COLOR=1",
        "FORCE_COLOR=0",
        "TERM=dumb",
        "PAGER=cat",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_EDITOR=true",
        "GIT_SEQUENCE_EDITOR=true",
        "GIT_PAGER=cat",
        "GIT_ASKPASS=true",
        "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
        "bash",
        "-lc",
        expect.stringMatching(/\nexec "\$0" "\$@"$/),
        "node",
        "-e",
        "process.stdout.write(process.argv[1])",
        "two",
      ],
    ]);
    expect(execRequests.map((request) => request.init.headers["Session-Id"])).toEqual([
      "tau-session-1",
      "tau-session-1",
    ]);
  });

  it("uses separate command sessions for separate cwd values", async () => {
    const requests = [];
    let nextSession = 1;
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: `tau-session-${nextSession++}` });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        return sseResponse(execSse({ stdout: "ok\n", exitCode: 0 }));
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await backend.runBash("pwd");
    await backend.runBash("pwd", { cwd: "/workspace/other" });

    const sessionRequests = requests.filter((request) => request.url.endsWith("/session"));
    expect(sessionRequests.map((request) => JSON.parse(request.init.body).cwd)).toEqual([
      "/workspace/repo",
      "/workspace/other",
    ]);
    const execRequests = requests.filter((request) => request.url.endsWith("/exec"));
    expect(execRequests.map((request) => request.init.headers["Session-Id"])).toEqual([
      "tau-session-1",
      "tau-session-2",
    ]);
  });

  it("applies the command timeout while creating the bridge session", async () => {
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: async (_url, init = {}) =>
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await expect(backend.runBash("pwd", { timeoutMs: 10 })).resolves.toMatchObject({
      output: "",
      stdout: "",
      stderr: "",
      timedOut: true,
      exitCode: null,
    });
  });

  it("deletes the command session when bridge exec is aborted", async () => {
    const requests = [];
    const execStarted = deferred();
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        execStarted.resolve();
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session/tau-session-1")) {
        return jsonResponse({});
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });
    const controller = new AbortController();

    const run = backend.runBash("sleep 10", { signal: controller.signal });
    await execStarted.promise;
    controller.abort();

    await expect(run).resolves.toMatchObject({ aborted: true, exitCode: null });
    await waitFor(() => requests.some((request) => request.init.method === "DELETE"));
  });

  it("deletes every per-cwd command session on dispose", async () => {
    const requests = [];
    let nextSession = 1;
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: `tau-session-${nextSession++}` });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        return sseResponse(execSse({ stdout: "ok\n", exitCode: 0 }));
      }
      if (String(url).includes("/v1/sandbox/sandbox-1/session/tau-session-")) {
        return jsonResponse({});
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });

    await backend.runBash("pwd");
    await backend.runBash("pwd", { cwd: "/workspace/other" });
    await backend.dispose();

    const deleteUrls = requests
      .filter((request) => request.init.method === "DELETE")
      .map((request) => request.url);
    expect(deleteUrls).toEqual([
      "https://bridge.example/v1/sandbox/sandbox-1/session/tau-session-1",
      "https://bridge.example/v1/sandbox/sandbox-1/session/tau-session-2",
    ]);
  });

  it("does not create a command session for an already-aborted signal", async () => {
    const requests = [];
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session")) {
        return jsonResponse({ id: "tau-session-1" });
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/exec")) {
        if (init.signal.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        throw new Error("exec request should have been aborted before fetch resolved");
      }
      if (String(url).endsWith("/v1/sandbox/sandbox-1/session/tau-session-1")) {
        return jsonResponse({});
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(backend.runBash("sleep 10", { signal: controller.signal })).resolves.toMatchObject(
      {
        aborted: true,
        exitCode: null,
      },
    );
    expect(requests).toHaveLength(0);
  });

  it("uses real execution-environment paths for bridge file reads", async () => {
    const requests = [];
    const fetchMock = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return new Response(Buffer.from("content", "utf-8"), { status: 200 });
    };
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: "default",
      baseUrl: "https://bridge.example/",
      fetch: fetchMock,
    });

    const content = await client.readFile("sandbox-1", "/workspace/repo/a file.txt");

    expect(content.toString("utf-8")).toBe("content");
    expect(requests[0].url).toBe(
      "https://bridge.example/v1/sandbox/sandbox-1/file/workspace/repo/a%20file.txt",
    );
  });

  it("resolves prompt context and machine metadata through the execution backend", async () => {
    const nodeScriptCalls = [];
    const backend = {
      async runNodeScript(script, args, options) {
        nodeScriptCalls.push({ script, args, options });
        return {
          output: JSON.stringify({
            platform: "linux",
            repoRoot: "/workspace/repo",
            agentsFiles: [
              { path: "/workspace/repo/AGENTS.md", content: "repo instructions" },
              { path: "/workspace/AGENTS.md", content: "workspace instructions" },
              {
                path: "/workspace/repo/docs/AGENTS.md",
                content: "configured instructions",
              },
            ],
            childAgentsFiles: ["/workspace/repo/src/AGENTS.md"],
          }),
          exitCode: 0,
          truncated: false,
        };
      },
      async readFile(path) {
        if (path === "/workspace/repo/AGENTS.md") {
          return { path, content: "repo instructions" };
        }
        if (path === "/workspace/AGENTS.md") {
          return { path, content: "workspace instructions" };
        }
        if (path === "/workspace/repo/src/AGENTS.md") {
          return { path, content: "nested instructions" };
        }
        throw new Error(`missing ${path}`);
      },
      async readFileBinary() {
        throw new Error("readFileBinary should not be called for prompt context");
      },
      async writeFile() {
        throw new Error("writeFile should not be called for prompt context");
      },
      async listDir(path) {
        throw new Error(`listDir should not be called for prompt context: ${path}`);
      },
    };
    const environment = new CloudflareSandboxExecutionEnvironment({
      bridgeId: "default",
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
      home: "/home/sandbox",
      backend,
    });

    const runtimeContext = await environment.resolveRuntimeContext({
      cwd: "/workspace/repo",
      persona: personas[0],
      discoveredSkills: [],
      includeAgentContext: true,
      agentContextFiles: ["/workspace/repo/docs/AGENTS.md"],
    });

    expect(runtimeContext.promptBootstrap.promptContext.cwd).toBe("/workspace/repo");
    expect(runtimeContext.promptBootstrap.agentsFiles).toEqual([
      "/workspace/repo/AGENTS.md",
      "/workspace/AGENTS.md",
      "/workspace/repo/docs/AGENTS.md",
    ]);
    expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
      "repo instructions",
    );
    expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
      "workspace instructions",
    );
    expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
      "configured instructions",
    );
    expect(runtimeContext.promptBootstrap.promptContext.projectContextBlock).toContain(
      "/workspace/repo/src/AGENTS.md",
    );
    expect(runtimeContext.promptBootstrap.promptContext).toMatchObject({
      repoRoot: "/workspace/repo",
      platform: "linux",
    });
    expect(nodeScriptCalls).toHaveLength(1);
    expect(nodeScriptCalls[0].args[0]).toBe("/workspace/repo");
    expect(JSON.parse(nodeScriptCalls[0].args[3])).toEqual(["/workspace/repo/docs/AGENTS.md"]);
    expect(nodeScriptCalls[0].options).toMatchObject({
      cwd: "/workspace/repo",
      maxCaptureBytes: 24 * 1024 * 1024,
    });
    expect(environment.snapshot()).toEqual({
      kind: "cloudflare-sandbox",
      bridgeId: "default",
      sandboxId: "sandbox-1",
      cwd: "/workspace/repo",
      home: "/home/sandbox",
    });
    const snapshot = environment.snapshot();
    snapshot.cwd = "/mutated";
    expect(environment.snapshot().cwd).toBe("/workspace/repo");
  });
});
