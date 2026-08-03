import { describe, expect, it } from "vitest";
import {
  applySessionProtocolDelta,
  createSessionProtocolDeltaMessage,
  createSessionProtocolEphemeralMessage,
  createSessionProtocolErrorResponse,
  createSessionProtocolPendingUserMessagesMessage,
  createSessionProtocolReadyMessage,
  createSessionProtocolRequest,
  createSessionProtocolSuccessResponse,
  parseSessionProtocolOutgoingLine,
  parseSessionProtocolRequestLine,
  SESSION_PROTOCOL_ERROR_CODES,
  SESSION_PROTOCOL_METHODS,
  SESSION_PROTOCOL_VERSION,
  validateSessionProtocolParams,
  validateSessionProtocolResult,
} from "../dist/protocol/session_protocol.js";
import {
  createProtocolBootstrap,
  createProtocolCatalog,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

const bootstrap = createProtocolBootstrap();
const catalog = createProtocolCatalog();

describe("session_protocol", () => {
  it("parses valid request lines", () => {
    const parsed = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "session.submit",
        params: { sessionId: "session-1", text: "hello" },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "session.submit",
        params: { sessionId: "session-1", text: "hello" },
      },
    });

    const list = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-2",
        method: "session.list",
        params: {},
      }),
    );
    expect(list).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-2",
        method: "session.list",
        params: {},
      },
    });

    const create = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-create",
        method: "session.create",
        params: {
          executionEnvironment: {
            kind: "local",
            cwd: "/repo",
            env: { GH_CONFIG_DIR: "/srv/cowork/gh" },
          },
          attributes: { source: "test" },
        },
      }),
    );
    expect(create).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-create",
        method: "session.create",
        params: {
          executionEnvironment: {
            kind: "local",
            cwd: "/repo",
            env: { GH_CONFIG_DIR: "/srv/cowork/gh" },
          },
          attributes: { source: "test" },
        },
      },
    });

    const attach = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-3",
        method: "session.observe",
        params: { sessionId: "session-1" },
      }),
    );
    expect(attach).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-3",
        method: "session.observe",
        params: { sessionId: "session-1" },
      },
    });

    const retry = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-retry",
        method: "session.retry",
        params: { sessionId: "session-1" },
      }),
    );
    expect(retry).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-retry",
        method: "session.retry",
        params: { sessionId: "session-1" },
      },
    });

    const exec = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-exec-bash",
        method: "session.exec",
        params: {
          sessionId: "session-1",
          execId: "exec-1",
          command: "git diff",
          cwd: "/repo",
          timeoutMs: 30000,
          maxCaptureBytes: 2097152,
        },
      }),
    );
    expect(exec).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-exec-bash",
        method: "session.exec",
        params: {
          sessionId: "session-1",
          execId: "exec-1",
          command: "git diff",
          cwd: "/repo",
          timeoutMs: 30000,
          maxCaptureBytes: 2097152,
        },
      },
    });

    const record = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-add-user",
        method: "session.record",
        params: {
          sessionId: "session-1",
          text: "review",
          historyEntryId: "history-1",
        },
      }),
    );
    expect(record).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-add-user",
        method: "session.record",
        params: {
          sessionId: "session-1",
          text: "review",
          historyEntryId: "history-1",
        },
      },
    });

    const setReasoning = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-reasoning",
        method: "session.setReasoning",
        params: { sessionId: "session-1", reasoning: "max" },
      }),
    );
    expect(setReasoning).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-reasoning",
        method: "session.setReasoning",
        params: { sessionId: "session-1", reasoning: "max" },
      },
    });

    const autocompletePaths = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-autocomplete-paths",
        method: "session.autocompletePaths",
        params: { sessionId: "session-1", query: "src", limit: 25 },
      }),
    );
    expect(autocompletePaths).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-autocomplete-paths",
        method: "session.autocompletePaths",
        params: { sessionId: "session-1", query: "src", limit: 25 },
      },
    });

    const rewind = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-rewind",
        method: "session.rewind",
        params: { sessionId: "session-1", historyEntryId: "history-1" },
      }),
    );
    expect(rewind).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-rewind",
        method: "session.rewind",
        params: { sessionId: "session-1", historyEntryId: "history-1" },
      },
    });

    const interruptSubagent = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-interrupt-subagent",
        method: "session.interruptSubagent",
        params: { sessionId: "session-1", subagentId: "subagent-1" },
      }),
    );
    expect(interruptSubagent).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-interrupt-subagent",
        method: "session.interruptSubagent",
        params: { sessionId: "session-1", subagentId: "subagent-1" },
      },
    });

    const ephemeralCreate = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-ephemeral-create",
        method: "session.ephemeral.create",
        params: {
          sessionId: "session-1",
          instructions: "review this",
          tools: ["bash", "view_image"],
        },
      }),
    );
    expect(ephemeralCreate).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-ephemeral-create",
        method: "session.ephemeral.create",
        params: {
          sessionId: "session-1",
          instructions: "review this",
          tools: ["bash", "view_image"],
        },
      },
    });

    const ephemeralSubmit = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-ephemeral-submit",
        method: "session.ephemeral.submit",
        params: {
          sessionId: "session-1",
          contextId: "ephemeral-1",
          threadId: "thread-1",
          forkFromThreadId: "thread-0",
          message: "review this",
        },
      }),
    );
    expect(ephemeralSubmit).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-ephemeral-submit",
        method: "session.ephemeral.submit",
        params: {
          sessionId: "session-1",
          contextId: "ephemeral-1",
          threadId: "thread-1",
          forkFromThreadId: "thread-0",
          message: "review this",
        },
      },
    });

    const ephemeralClose = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-ephemeral-close",
        method: "session.ephemeral.close",
        params: { sessionId: "session-1", contextId: "ephemeral-1" },
      }),
    );
    expect(ephemeralClose).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-ephemeral-close",
        method: "session.ephemeral.close",
        params: { sessionId: "session-1", contextId: "ephemeral-1" },
      },
    });

    const compact = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-compact",
        method: "session.compact",
        params: {
          sessionId: "session-1",
          mode: "summary-and-last",
          guidance: "preserve decisions",
        },
      }),
    );
    expect(compact).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-compact",
        method: "session.compact",
        params: {
          sessionId: "session-1",
          mode: "summary-and-last",
          guidance: "preserve decisions",
        },
      },
    });

    expect(
      parseSessionProtocolRequestLine(
        JSON.stringify({
          version: SESSION_PROTOCOL_VERSION,
          type: "request",
          id: "req-prune",
          method: "session.prune",
          params: { sessionId: "session-1", strategy: "smart" },
        }),
      ).ok,
    ).toBe(false);
  });

  it("round-trips sampled assistant messages into later sampling contexts", () => {
    const sampledMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Classifying the request..." },
        { type: "text", text: "authentication" },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-sol",
      responseModel: "gpt-5.6-sol-2026-07-01",
      responseId: "response-1",
      diagnostics: [
        {
          type: "provider-retry",
          timestamp: 1,
          error: { name: "Error", message: "retryable", code: 429 },
          details: { attempt: 1 },
        },
      ],
      stopReason: "stop",
      usage: {
        input: 42,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 3,
        totalTokens: 51,
        cost: {
          input: 0.0001,
          output: 0.0002,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.0003,
        },
      },
      timestamp: 1,
    };

    expect(validateSessionProtocolResult("session.sample", { message: sampledMessage })).toEqual({
      ok: true,
      value: { message: sampledMessage },
    });

    expect(
      validateSessionProtocolParams("session.sample", {
        sessionId: "session-1",
        context: {
          systemPrompt: "Classify support tickets.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "I cannot log in" }],
              timestamp: 0,
            },
            sampledMessage,
          ],
          tools: [
            {
              name: "lookup_ticket",
              description: "Look up a ticket.",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        options: { reasoning: "low", maxTokens: 500, temperature: 0 },
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        context: {
          systemPrompt: "Classify support tickets.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "I cannot log in" }],
              timestamp: 0,
            },
            sampledMessage,
          ],
          tools: [
            {
              name: "lookup_ticket",
              description: "Look up a ticket.",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        options: { reasoning: "low", maxTokens: 500 },
      },
    });

    expect(
      validateSessionProtocolParams("session.sample", {
        sessionId: "session-1",
        context: { systemPrompt: "system", messages: [] },
        options: { maxTokens: 0 },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: SESSION_PROTOCOL_ERROR_CODES.invalidParams }),
    });
    expect(
      validateSessionProtocolResult("session.sample", {
        message: { role: "assistant", content: [] },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest }),
    });
    expect(
      validateSessionProtocolResult("session.sample", {
        message: { ...sampledMessage, diagnostics: [{}] },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest }),
    });
  });

  it("returns structured parse and validation errors", () => {
    const malformed = parseSessionProtocolRequestLine("{not-json}");
    expect(malformed.ok).toBe(false);
    expect(malformed.error.code).toBe(SESSION_PROTOCOL_ERROR_CODES.parseError);

    const unknownMethod = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-unknown",
        method: "session.unknown",
        params: {},
      }),
    );
    expect(unknownMethod).toEqual({
      ok: false,
      id: "req-unknown",
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.methodNotFound,
      }),
    });

    const emptyId = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "",
        method: "session.snapshot",
        params: { sessionId: "session-1" },
      }),
    );
    expect(emptyId).toEqual({
      ok: false,
      id: null,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      }),
    });

    const invalidSubmit = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-invalid-submit",
        method: "session.submit",
        params: { sessionId: "session-1", text: 123 },
      }),
    );
    expect(invalidSubmit).toEqual({
      ok: false,
      id: "req-invalid-submit",
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidParams,
      }),
    });

    const requestWithUnsupportedFields = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-unsupported",
        method: "session.submit",
        params: { sessionId: "session-1", text: "hello" },
        legacy: true,
      }),
    );
    expect(requestWithUnsupportedFields).toEqual({
      ok: true,
      request: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-unsupported",
        method: "session.submit",
        params: { sessionId: "session-1", text: "hello" },
      },
    });

    const requestWithoutParams = parseSessionProtocolRequestLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-without-params",
        method: "session.snapshot",
      }),
    );
    expect(requestWithoutParams).toEqual({
      ok: false,
      id: "req-without-params",
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: "request.params is required",
      }),
    });
  });

  it("returns structured parse errors for malformed outgoing messages", () => {
    const malformed = parseSessionProtocolOutgoingLine("{bad-json}");
    expect(malformed).toEqual({
      ok: false,
      reason: "parse_error",
      messageType: null,
      id: null,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.parseError,
      }),
    });

    const badVersion = parseSessionProtocolOutgoingLine(
      JSON.stringify({
        version: 99,
        type: "ready",
        methods: [...SESSION_PROTOCOL_METHODS],
      }),
    );
    expect(badVersion).toEqual({
      ok: false,
      reason: "unsupported_version",
      messageType: null,
      id: null,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: "unsupported session protocol version: 99",
      }),
    });

    const duplicateReadyMethods = parseSessionProtocolOutgoingLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "ready",
        methods: [SESSION_PROTOCOL_METHODS[0], SESSION_PROTOCOL_METHODS[0]],
      }),
    );
    expect(duplicateReadyMethods).toEqual({
      ok: false,
      reason: "invalid_payload",
      messageType: "ready",
      id: null,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: expect.stringContaining("duplicate session protocol method"),
      }),
    });

    const malformedResponse = parseSessionProtocolOutgoingLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "response",
        id: "req-9",
        ok: false,
        error: { code: "not-a-code", message: 123 },
      }),
    );
    expect(malformedResponse).toEqual({
      ok: false,
      reason: "invalid_payload",
      messageType: "response",
      id: "req-9",
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      }),
    });

    const responseWithEmptyId = parseSessionProtocolOutgoingLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "response",
        id: "",
        ok: true,
        result: {},
      }),
    );
    expect(responseWithEmptyId).toEqual({
      ok: false,
      reason: "response_invalid_id",
      messageType: "response",
      id: null,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      }),
    });

    const responseWithUnsupportedFields = parseSessionProtocolOutgoingLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "response",
        id: "req-10",
        ok: true,
        result: { shutdown: true },
        error: {
          code: SESSION_PROTOCOL_ERROR_CODES.internalError,
          message: "should not be here",
        },
      }),
    );
    expect(responseWithUnsupportedFields).toEqual({
      ok: true,
      message: {
        version: SESSION_PROTOCOL_VERSION,
        type: "response",
        id: "req-10",
        ok: true,
        result: { shutdown: true },
      },
    });

    const oldEventEnvelope = parseSessionProtocolOutgoingLine(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        type: "event",
        sessionId: "session-1",
        sessionRevision: 1,
        event: { type: "notice", severity: "info", text: "ok" },
        extra: "not canonical",
      }),
    );
    expect(oldEventEnvelope).toEqual({
      ok: false,
      reason: "unsupported_message_type",
      messageType: null,
      id: null,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: "unsupported session protocol message type: event",
      }),
    });
  });

  it("validates per-method params", () => {
    expect(
      validateSessionProtocolParams("initialize", {
        client: { name: "tau-sdk", version: "1" },
      }),
    ).toEqual({
      ok: true,
      value: {
        client: {
          name: "tau-sdk",
          version: "1",
        },
      },
    });

    expect(
      validateSessionProtocolParams("initialize", {
        client: {
          name: "tau-sdk",
          version: "1",
          tools: [
            {
              name: "local_picker",
              description: "Pick a local item.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              executionTimeoutMs: 60_000,
            },
          ],
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        client: {
          name: "tau-sdk",
          version: "1",
          tools: [
            {
              name: "local_picker",
              description: "Pick a local item.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              executionTimeoutMs: 60_000,
            },
          ],
        },
      },
    });

    const invalidInitialize = validateSessionProtocolParams("initialize", {});
    expect(invalidInitialize).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidParams,
      }),
    });

    expect(
      validateSessionProtocolParams("session.interrupt", {
        sessionId: "session-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1" },
    });
    expect(
      validateSessionProtocolParams("session.create", {
        executionEnvironment: {
          kind: "local",
          cwd: "/repo",
          env: { GH_CONFIG_DIR: "/srv/cowork/gh" },
        },
        attributes: { source: "test" },
        personaId: "coder",
        reasoning: "high",
      }),
    ).toEqual({
      ok: true,
      value: {
        executionEnvironment: {
          kind: "local",
          cwd: "/repo",
          env: { GH_CONFIG_DIR: "/srv/cowork/gh" },
        },
        attributes: { source: "test" },
        personaId: "coder",
        reasoning: "high",
      },
    });
    expect(
      validateSessionProtocolParams("session.create", {
        executionEnvironment: {
          kind: "cloudflare-sandbox",
          bridgeId: "default",
          sandboxId: "sandbox-1",
          cwd: "/workspace/repo",
        },
        attributes: { source: "test" },
      }),
    ).toEqual({
      ok: true,
      value: {
        executionEnvironment: {
          kind: "cloudflare-sandbox",
          bridgeId: "default",
          sandboxId: "sandbox-1",
          cwd: "/workspace/repo",
        },
        attributes: { source: "test" },
      },
    });
    expect(
      validateSessionProtocolParams("session.create", {
        executionEnvironment: {
          kind: "fly-sprite",
          apiId: "default",
          spriteName: "sprite-1",
          cwd: "/home/sprite/repo",
        },
        attributes: { source: "test" },
      }),
    ).toEqual({
      ok: true,
      value: {
        executionEnvironment: {
          kind: "fly-sprite",
          apiId: "default",
          spriteName: "sprite-1",
          cwd: "/home/sprite/repo",
        },
        attributes: { source: "test" },
      },
    });
    expect(
      validateSessionProtocolParams("session.create", {
        executionEnvironment: { kind: "local", cwd: "/repo", env: { HOME: "/tmp" } },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "invalid_params",
        message:
          "session.create params.executionEnvironment.env must use valid environment variable names and string values without null bytes and cannot override HOME",
      },
    });
    expect(validateSessionProtocolParams("session.create", {})).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidParams,
        message: "session.create params.executionEnvironment must be an object",
      }),
    });
    expect(validateSessionProtocolParams("session.list", {})).toEqual({
      ok: true,
      value: {},
    });
    expect(
      validateSessionProtocolParams("session.observe", {
        sessionId: "session-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1" },
    });
    expect(
      validateSessionProtocolParams("session.reload", {
        sessionId: "session-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1" },
    });
    expect(
      validateSessionProtocolParams("session.retry", {
        sessionId: "session-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1" },
    });
    expect(
      validateSessionProtocolParams("session.autocompletePaths", {
        sessionId: "session-1",
        query: "src",
        limit: 25,
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1", query: "src", limit: 25 },
    });
    expect(
      validateSessionProtocolParams("session.exec", {
        sessionId: "session-1",
        execId: "exec-1",
        command: "pwd",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1", execId: "exec-1", command: "pwd" },
    });
    expect(
      validateSessionProtocolParams("session.exec", {
        sessionId: "session-1",
        execId: "exec-1",
        command: "git diff",
        args: ["one", "two"],
        env: { GIT_OPTIONAL_LOCKS: "0" },
        stdinBase64: Buffer.from("input").toString("base64"),
        cwd: "/repo",
        timeoutMs: 30000,
        maxCaptureBytes: 2097152,
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        execId: "exec-1",
        command: "git diff",
        args: ["one", "two"],
        env: { GIT_OPTIONAL_LOCKS: "0" },
        stdinBase64: Buffer.from("input").toString("base64"),
        cwd: "/repo",
        timeoutMs: 30000,
        maxCaptureBytes: 2097152,
      },
    });
    expect(
      validateSessionProtocolParams("session.exec", {
        sessionId: "session-1",
        execId: "exec-1",
        command: "git diff",
        maxCaptureBytes: 24 * 1024 * 1024 + 1,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "invalid_params",
        message:
          "session.exec params.maxCaptureBytes must be a positive integer no greater than 25165824 when provided",
      },
    });
    for (const [params, message] of [
      [
        { sessionId: "session-1", execId: "exec-1", command: "printf \0" },
        "session.exec params.command must be a non-empty string without null bytes",
      ],
      [
        { sessionId: "session-1", execId: "exec-1", command: "printf", args: ["a\0b"] },
        "session.exec params.args must be an array of strings without null bytes when provided",
      ],
      [
        { sessionId: "session-1", execId: "exec-1", command: "pwd", env: { HOME: "/tmp" } },
        "session.exec params.env must use valid environment variable names and string values without null bytes and cannot override HOME",
      ],
      [
        { sessionId: "session-1", execId: "exec-1", command: "pwd", cwd: "/repo\0bad" },
        "session.exec params.cwd must be a non-empty string without null bytes when provided",
      ],
    ]) {
      expect(validateSessionProtocolParams("session.exec", params)).toEqual({
        ok: false,
        error: { code: "invalid_params", message },
      });
    }
    expect(
      validateSessionProtocolParams("session.cancelExec", {
        sessionId: "session-1",
        execId: "exec-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1", execId: "exec-1" },
    });
    expect(
      validateSessionProtocolParams("session.record", {
        sessionId: "session-1",
        text: "review",
        historyEntryId: "history-1",
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        text: "review",
        historyEntryId: "history-1",
      },
    });
    expect(
      validateSessionProtocolParams("session.setReasoning", {
        sessionId: "session-1",
        reasoning: "max",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1", reasoning: "max" },
    });
    expect(
      validateSessionProtocolParams("session.rewind", {
        sessionId: "session-1",
        historyEntryId: "history-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1", historyEntryId: "history-1" },
    });
    expect(
      validateSessionProtocolParams("session.interruptSubagent", {
        sessionId: "session-1",
        subagentId: "subagent-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1", subagentId: "subagent-1" },
    });
    expect(
      validateSessionProtocolParams("session.ephemeral.create", {
        sessionId: "session-1",
        instructions: "review this",
        tools: ["bash", "view_image"],
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        instructions: "review this",
        tools: ["bash", "view_image"],
      },
    });
    expect(
      validateSessionProtocolParams("session.ephemeral.submit", {
        sessionId: "session-1",
        contextId: "ephemeral-1",
        threadId: "thread-1",
        message: "review this",
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        contextId: "ephemeral-1",
        threadId: "thread-1",
        message: "review this",
      },
    });
    expect(
      validateSessionProtocolParams("session.ephemeral.close", {
        sessionId: "session-1",
        contextId: "ephemeral-1",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-1", contextId: "ephemeral-1" },
    });

    for (const method of ["session.queue", "session.steer"]) {
      expect(
        validateSessionProtocolParams(method, {
          sessionId: "session-1",
          text: "   ",
        }),
      ).toMatchObject({
        ok: false,
        error: { code: SESSION_PROTOCOL_ERROR_CODES.invalidParams },
      });
    }

    const submitWithEmptyHistoryId = validateSessionProtocolParams("session.submit", {
      sessionId: "session-1",
      text: "hello",
      historyEntryId: "",
    });
    expect(submitWithEmptyHistoryId).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidParams,
        message: "session.submit params.historyEntryId must be a non-empty string when provided",
      }),
    });

    expect(
      validateSessionProtocolParams("session.ephemeral.submit", {
        sessionId: "session-1",
        contextId: "ephemeral-1",
        threadId: "thread-1",
        forkFromThreadId: "",
        message: "review this",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidParams,
        message:
          "session.ephemeral.submit params.forkFromThreadId must be a non-empty string when provided",
      }),
    });
  });

  it("constructs outbound requests through shared method params validation", () => {
    expect(
      createSessionProtocolRequest("req-out", "session.submit", {
        sessionId: "session-1",
        text: "hello",
      }),
    ).toEqual({
      ok: true,
      value: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-out",
        method: "session.submit",
        params: { sessionId: "session-1", text: "hello" },
      },
    });

    expect(
      createSessionProtocolRequest("req-extra", "session.submit", {
        sessionId: "session-1",
        text: "hello",
        mode: "submit",
      }),
    ).toEqual({
      ok: true,
      value: {
        version: SESSION_PROTOCOL_VERSION,
        type: "request",
        id: "req-extra",
        method: "session.submit",
        params: { sessionId: "session-1", text: "hello" },
      },
    });

    expect(
      createSessionProtocolRequest("", "session.submit", {
        sessionId: "session-1",
        text: "hello",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: "request id must be a non-empty string",
      }),
    });
  });

  it("validates per-method results", () => {
    expect(
      validateSessionProtocolResult("initialize", {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        methods: [SESSION_PROTOCOL_METHODS[0], SESSION_PROTOCOL_METHODS[0]],
        alreadyInitialized: false,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: expect.stringContaining("duplicate session protocol method"),
      }),
    });

    const snapshot = createProtocolSnapshot({ sessionId: "session-1", bootstrap });
    expect(validateSessionProtocolResult("session.create", { sessionId: "session-1" })).toEqual({
      ok: true,
      value: { sessionId: "session-1" },
    });
    expect(
      validateSessionProtocolResult("session.observe", {
        snapshot,
        pendingUserMessages: { revision: 1, messages: [] },
      }),
    ).toEqual({
      ok: true,
      value: {
        snapshot,
        pendingUserMessages: { revision: 1, messages: [] },
      },
    });
    expect(validateSessionProtocolResult("session.observe", snapshot)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      }),
    });

    expect(
      validateSessionProtocolResult("session.retry", {
        turn: { status: "completed", stopReason: "stop" },
      }),
    ).toEqual({
      ok: true,
      value: { turn: { status: "completed", stopReason: "stop" } },
    });
    expect(
      validateSessionProtocolResult("session.retry", {
        userHistoryEntryId: "history-user",
        turn: { status: "completed", stopReason: "stop" },
      }),
    ).toEqual({
      ok: true,
      value: { turn: { status: "completed", stopReason: "stop" } },
    });

    expect(
      validateSessionProtocolResult("session.exec", createProtocolExecResult({ command: "pwd" })),
    ).toEqual({
      ok: true,
      value: createProtocolExecResult({ command: "pwd" }),
    });
    expect(validateSessionProtocolResult("session.cancelExec", { cancelled: true })).toEqual({
      ok: true,
      value: { cancelled: true },
    });
    expect(
      validateSessionProtocolResult("session.autocompletePaths", {
        paths: ["src/main.ts", "src/tui/"],
      }),
    ).toEqual({
      ok: true,
      value: { paths: ["src/main.ts", "src/tui/"] },
    });

    expect(
      validateSessionProtocolResult("session.setReasoning", {
        revision: 2,
        settings: { personaId: "default", reasoning: "high" },
      }),
    ).toEqual({
      ok: true,
      value: {
        revision: 2,
        settings: { personaId: "default", reasoning: "high" },
      },
    });

    expect(
      validateSessionProtocolResult(
        "session.snapshot",
        createProtocolSnapshot({ bootstrap, catalog }),
      ),
    ).toEqual({
      ok: true,
      value: createProtocolSnapshot({ bootstrap, catalog }),
    });

    const tieredSnapshot = createProtocolSnapshot({
      bootstrap: {
        ...bootstrap,
        model: {
          ...bootstrap.persona.model,
          cost: {
            ...bootstrap.persona.model.cost,
            tiers: [
              {
                inputTokensAbove: 272000,
                input: 2,
                output: 9,
                cacheRead: 0.2,
                cacheWrite: 2.5,
              },
            ],
          },
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        },
      },
    });
    expect(validateSessionProtocolResult("session.snapshot", tieredSnapshot)).toEqual({
      ok: true,
      value: tieredSnapshot,
    });

    expect(
      validateSessionProtocolResult("session.rewind", {
        snapshot: createProtocolSnapshot({ bootstrap, catalog, revision: 2 }),
        historyEntryId: "history-1",
        text: "rewound text",
        removedEntryIds: ["history-1", "assistant-1"],
      }),
    ).toEqual({
      ok: true,
      value: {
        snapshot: createProtocolSnapshot({ bootstrap, catalog, revision: 2 }),
        historyEntryId: "history-1",
        text: "rewound text",
        removedEntryIds: ["history-1", "assistant-1"],
      },
    });

    expect(
      validateSessionProtocolResult("session.interruptSubagent", {
        found: true,
      }),
    ).toEqual({
      ok: true,
      value: { found: true },
    });
    expect(
      validateSessionProtocolResult("session.ephemeral.create", {
        contextId: "ephemeral-1",
      }),
    ).toEqual({
      ok: true,
      value: { contextId: "ephemeral-1" },
    });
    expect(
      validateSessionProtocolResult("session.ephemeral.submit", {
        threadId: "thread-1",
        response: "looks good",
      }),
    ).toEqual({
      ok: true,
      value: { threadId: "thread-1", response: "looks good" },
    });
    expect(
      validateSessionProtocolResult("session.ephemeral.close", {
        closed: true,
      }),
    ).toEqual({
      ok: true,
      value: { closed: true },
    });

    expect(
      validateSessionProtocolResult("session.exec", {
        output: "diff",
        stdout: "diff",
        stderr: "",
        exitCode: 0,
        truncated: false,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      }),
    ).toEqual({
      ok: true,
      value: {
        output: "diff",
        stdout: "diff",
        stderr: "",
        exitCode: 0,
        truncated: false,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      },
    });

    const recordSnapshot = createProtocolSnapshot({
      revision: 2,
      historyEntries: [
        {
          id: "history-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "review" }],
          },
        },
      ],
    });
    expect(
      validateSessionProtocolResult("session.record", {
        snapshot: recordSnapshot,
        userHistoryEntryId: "history-1",
      }),
    ).toEqual({
      ok: true,
      value: {
        snapshot: recordSnapshot,
        userHistoryEntryId: "history-1",
      },
    });

    const reloadSnapshot = createProtocolSnapshot();
    expect(
      validateSessionProtocolResult("session.reload", {
        snapshot: reloadSnapshot,
        warnings: ["config warning"],
        counts: { personas: 1, prompts: 1, skills: 0 },
      }),
    ).toEqual({
      ok: true,
      value: {
        snapshot: reloadSnapshot,
        warnings: ["config warning"],
        counts: { personas: 1, prompts: 1, skills: 0 },
      },
    });

    const flySnapshot = createProtocolSnapshot({
      executionEnvironment: {
        kind: "fly-sprite",
        apiId: "default",
        spriteName: "sprite-1",
        cwd: "/home/sprite/repo",
        home: "/home/sprite",
      },
    });
    expect(validateSessionProtocolResult("session.snapshot", flySnapshot)).toEqual({
      ok: true,
      value: flySnapshot,
    });

    const cloudflareSnapshot = createProtocolSnapshot({
      executionEnvironment: {
        kind: "cloudflare-sandbox",
        bridgeId: "default",
        sandboxId: "sandbox-1",
        cwd: "/workspace/repo",
        home: "/home/sandbox",
      },
    });
    expect(validateSessionProtocolResult("session.snapshot", cloudflareSnapshot)).toEqual({
      ok: true,
      value: cloudflareSnapshot,
    });

    const promptSnapshot = createProtocolSnapshot({
      bootstrap: {
        ...bootstrap,
        prompt: {
          environmentTag: "\n<environment></environment>\n",
          subagentPrompts: { reviewer: "\nsubagent prompt\n" },
        },
      },
      executionEnvironment: {
        kind: "local",
        cwd: "/repo with spaces",
        home: "/home/user",
      },
    });
    expect(validateSessionProtocolResult("session.snapshot", promptSnapshot)).toEqual({
      ok: true,
      value: promptSnapshot,
    });

    const runningDraftSnapshot = createProtocolSnapshot({
      lifecycle: "running",
      messages: [
        {
          id: "system",
          state: "committed",
          modelVisible: true,
          message: { role: "system", content: "system prompt", timestamp: 0 },
        },
        {
          id: "assistant-entry-1",
          state: "draft",
          modelVisible: false,
          message: {
            role: "assistant",
            timestamp: 1,
            content: [
              { type: "thinking", thinking: "checking" },
              { type: "text", text: "working" },
            ],
          },
        },
      ],
    });
    expect(validateSessionProtocolResult("session.snapshot", runningDraftSnapshot)).toEqual({
      ok: true,
      value: runningDraftSnapshot,
    });

    const hiddenMessageSnapshot = createProtocolSnapshot({
      messages: [
        {
          id: "system",
          state: "committed",
          modelVisible: true,
          message: { role: "system", content: "system prompt", timestamp: 0 },
        },
        {
          id: "model-only-1",
          state: "committed",
          modelVisible: true,
          message: {
            role: "user",
            content: [{ type: "text", text: "hidden from default timeline" }],
            timestamp: 0,
          },
        },
      ],
      timeline: [],
    });
    expect(validateSessionProtocolResult("session.snapshot", hiddenMessageSnapshot)).toEqual({
      ok: true,
      value: hiddenMessageSnapshot,
    });

    const interruptedSnapshot = createProtocolSnapshot({
      messages: [
        {
          id: "system",
          state: "committed",
          modelVisible: true,
          message: { role: "system", content: "system prompt", timestamp: 0 },
        },
        {
          id: "assistant-entry-1",
          state: "interrupted",
          modelVisible: true,
          message: {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.5",
            stopReason: "aborted",
            content: [{ type: "text", text: "partial response kept" }],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            timestamp: 1,
          },
        },
      ],
    });
    expect(validateSessionProtocolResult("session.snapshot", interruptedSnapshot)).toEqual({
      ok: true,
      value: interruptedSnapshot,
    });

    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...createProtocolSnapshot(),
        status: "running",
      }),
    ).toEqual({
      ok: true,
      value: createProtocolSnapshot(),
    });

    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...createProtocolSnapshot(),
        runtimeConfig: {},
      }),
    ).toEqual({
      ok: true,
      value: createProtocolSnapshot(),
    });

    const snapshotWithUnknownModelFields = validateSessionProtocolResult(
      "session.snapshot",
      createProtocolSnapshot({
        bootstrap: {
          ...bootstrap,
          model: {
            ...bootstrap.persona.model,
            headers: { authorization: "Bearer secret", "x-custom": "secret" },
          },
        },
      }),
    );
    expect(snapshotWithUnknownModelFields.ok).toBe(true);
    if (snapshotWithUnknownModelFields.ok) {
      expect(snapshotWithUnknownModelFields.value.bootstrap.model).not.toHaveProperty("headers");
    }

    expect(
      validateSessionProtocolResult("session.snapshot", {
        sessionId: "session-1",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: expect.stringContaining("session.snapshot result is invalid"),
      }),
    });

    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...createProtocolSnapshot(),
        history: [{ role: "alien", content: [] }],
      }),
    ).toEqual({
      ok: true,
      value: createProtocolSnapshot(),
    });

    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...createProtocolSnapshot(),
        messages: [
          {
            id: "system",
            state: "committed",
            modelVisible: true,
            message: { role: "system", content: "system prompt", timestamp: 0 },
          },
          {
            id: "entry-1",
            state: "committed",
            modelVisible: true,
            message: {
              role: "user",
              content: [{ type: "text", text: "one" }],
              timestamp: 0,
            },
          },
          {
            id: "entry-1",
            state: "committed",
            modelVisible: true,
            message: {
              role: "user",
              content: [{ type: "text", text: "two" }],
              timestamp: 0,
            },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: expect.stringContaining("duplicate message id 'entry-1'"),
      }),
    });

    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...createProtocolSnapshot(),
        timeline: [
          {
            type: "message",
            id: "timeline-missing",
            messageId: "missing-message",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: expect.stringContaining(
          "timeline message item 'timeline-missing' references unknown message 'missing-message'",
        ),
      }),
    });

    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...createProtocolSnapshot(),
        bootstrap: {
          ...createProtocolSnapshot().bootstrap,
          prompt: {
            ...createProtocolSnapshot().bootstrap.prompt,
            baseSystemPrompt: "old inline prompt",
          },
        },
      }),
    ).toEqual({
      ok: true,
      value: createProtocolSnapshot(),
    });
  });

  it("rejects semantically mismatched snapshot projections", () => {
    const messages = [
      {
        id: "system",
        state: "committed",
        modelVisible: true,
        message: { role: "system", content: "system prompt", timestamp: 0 },
      },
      {
        id: "user-1",
        state: "committed",
        modelVisible: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "run it" }],
          timestamp: 1,
        },
      },
      {
        id: "assistant-1",
        state: "draft",
        modelVisible: false,
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pwd" } },
          ],
          timestamp: 2,
        },
      },
      {
        id: "result-1",
        state: "committed",
        modelVisible: true,
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          content: [{ type: "text", text: "/repo" }],
          isError: false,
          timestamp: 3,
        },
      },
    ];
    const tool = {
      id: "tool-1",
      toolCallId: "tool-1",
      toolName: "bash",
      call: { messageId: "assistant-1", contentIndex: 0 },
      resultMessageId: "result-1",
      status: "succeeded",
      facetIds: [],
    };
    const agent = {
      id: "agent-1",
      name: "default",
      title: "research",
      availability: "idle",
      model: { provider: "anthropic", id: "claude-opus-4-8", reasoning: "medium" },
      workingDirectory: "/repo",
      createdAt: 1,
      run: {
        revision: 1,
        status: "succeeded",
        startedAt: 1,
        finishedAt: 2,
        interruptRequested: false,
        response: "result",
      },
      costTotal: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextWindowUsageTokens: 0,
        contextWindow: 1000,
      },
    };
    const snapshot = createProtocolSnapshot({
      messages,
      timeline: [
        { type: "notice", id: "notice-1", notice: { severity: "info", text: "hi", timestamp: 1 } },
      ],
      tools: { "tool-1": tool },
      agents: { "agent-1": agent },
    });
    const streamingTool = {
      id: "streaming-tool",
      toolCallId: "streaming-tool",
      toolName: "write",
      status: "streaming",
      origin: { messageId: "assistant-1", contentIndex: 2 },
      facetIds: [],
    };
    const streamingResult = validateSessionProtocolResult("session.snapshot", {
      ...snapshot,
      messages: messages.map((message) =>
        message.id === "assistant-1"
          ? { ...message, message: { ...message.message, content: [] } }
          : message,
      ),
      tools: { "streaming-tool": streamingTool },
    });
    expect(streamingResult).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          tools: { "streaming-tool": streamingTool },
        }),
      }),
    );
    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...snapshot,
        agentState: {
          revision: 1,
          contextEpoch: "current-epoch",
          usageCheckpoint: {
            historyEntryId: "assistant-1",
            contextEpoch: "stale-epoch",
            tokens: 10,
          },
        },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining("usage checkpoint context epoch must match agent state"),
      }),
    });
    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...snapshot,
        agentState: {
          revision: 1,
          contextEpoch: "current-epoch",
          usageCheckpoint: {
            historyEntryId: "assistant-1",
            contextEpoch: "current-epoch",
            tokens: 10,
          },
        },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining(
          "usage checkpoint must reference a completed model-visible assistant response",
        ),
      }),
    });
    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...snapshot,
        tools: {
          "streaming-tool": {
            ...streamingTool,
            origin: { messageId: "user-1", contentIndex: 0 },
          },
        },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining(
          "streaming tool 'streaming-tool' does not reference a draft assistant message",
        ),
      }),
    });

    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...snapshot,
        tools: {
          "tool-1": { ...tool, call: { messageId: "assistant-1", contentIndex: 1 } },
        },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining("tool 'tool-1' does not match its call message content"),
      }),
    });
    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...snapshot,
        tools: { "tool-1": { ...tool, resultMessageId: "user-1" } },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining("tool 'tool-1' does not match its result message"),
      }),
    });
    expect(
      validateSessionProtocolResult("session.snapshot", {
        ...snapshot,
        facets: {
          "operation-facet": {
            id: "operation-facet",
            subject: { type: "operation", id: "notice-1" },
            kind: "test",
            version: 1,
            data: {},
          },
        },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining(
          "facet 'operation-facet' references unknown operation subject",
        ),
      }),
    });
  });

  it("parses and constructs pending user message state", () => {
    const message = createSessionProtocolPendingUserMessagesMessage({
      sessionId: "session-1",
      state: {
        revision: 2,
        messages: [
          { id: "steer-1", mode: "steer", text: "change direction" },
          { id: "queue-1", mode: "queue", text: "run tests" },
        ],
      },
    });

    expect(parseSessionProtocolOutgoingLine(JSON.stringify(message))).toEqual({
      ok: true,
      message,
    });
    expect(
      parseSessionProtocolOutgoingLine(
        JSON.stringify({
          ...message,
          state: {
            ...message.state,
            messages: [message.state.messages[0], message.state.messages[0]],
          },
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("duplicate pending user message id 'steer-1'"),
        }),
      }),
    );
  });

  it("builds ready/delta/error messages with versioned envelopes", () => {
    const ready = createSessionProtocolReadyMessage();
    expect(ready).toEqual(
      expect.objectContaining({
        version: SESSION_PROTOCOL_VERSION,
        type: "ready",
        methods: SESSION_PROTOCOL_METHODS,
      }),
    );
    expect(ready).not.toHaveProperty("sessionId");

    const delta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 1,
      toRevision: 2,
      reason: "notice",
      delta: {
        type: "snapshot.patch",
        changes: [{ type: "lifecycle.set", lifecycle: "idle" }],
      },
    });
    expect(delta).toEqual({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: "session-1",
      fromRevision: 1,
      toRevision: 2,
      reason: "notice",
      delta: {
        type: "snapshot.patch",
        changes: [{ type: "lifecycle.set", lifecycle: "idle" }],
      },
    });
    expect(parseSessionProtocolOutgoingLine(JSON.stringify(delta))).toEqual({
      ok: true,
      message: delta,
    });

    const settingsDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 2,
      toRevision: 3,
      reason: "configuration",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "settings.set",
            settings: { personaId: "default", reasoning: "high" },
          },
        ],
      },
    });
    const settingsPatchedSnapshot = applySessionProtocolDelta(
      createProtocolSnapshot({
        sessionId: "session-1",
        revision: 2,
      }),
      settingsDelta,
    );
    expect(settingsPatchedSnapshot.revision).toBe(3);
    expect(settingsPatchedSnapshot.settings).toEqual({
      personaId: "default",
      reasoning: "high",
    });

    const goalDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 3,
      toRevision: 4,
      reason: "goal",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "goal.set",
            goal: { objective: "Ship it", status: "active" },
          },
        ],
      },
    });
    expect(applySessionProtocolDelta(settingsPatchedSnapshot, goalDelta).goal).toEqual({
      objective: "Ship it",
      status: "active",
    });

    const invalidAgentStateDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 2,
      toRevision: 3,
      reason: "maintenance",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "agent-state.set",
            agentState: {
              revision: 1,
              contextEpoch: "epoch-1",
              usageCheckpoint: {
                historyEntryId: "missing-assistant",
                contextEpoch: "epoch-1",
                tokens: 10,
              },
            },
          },
        ],
      },
    });
    expect(() =>
      applySessionProtocolDelta(
        createProtocolSnapshot({ sessionId: "session-1", revision: 2 }),
        invalidAgentStateDelta,
      ),
    ).toThrow("session delta produced an invalid snapshot");

    const checkpointSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 2,
      historyEntries: [
        {
          id: "checkpoint-assistant",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5.5",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          },
        },
      ],
      agentState: {
        revision: 1,
        contextEpoch: "epoch-1",
        usageCheckpoint: {
          historyEntryId: "checkpoint-assistant",
          contextEpoch: "epoch-1",
          tokens: 10,
        },
      },
    });
    const invalidCheckpointTargetDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 2,
      toRevision: 3,
      reason: "assistant-stream",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "message.replace",
            message: {
              id: "checkpoint-assistant",
              state: "draft",
              modelVisible: false,
              message: { role: "assistant", content: [], timestamp: 1 },
            },
          },
        ],
      },
    });
    expect(() =>
      applySessionProtocolDelta(checkpointSnapshot, invalidCheckpointTargetDelta),
    ).toThrow("session delta produced an invalid snapshot");

    const ephemeral = createSessionProtocolEphemeralMessage({
      sessionId: "session-1",
      event: {
        type: "ephemeral-agent.thread-update",
        contextId: "ephemeral-1",
        threadId: "thread-1",
        update: {
          costTotal: 0,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindowUsageTokens: 3,
            contextWindow: 400000,
          },
          lastActivityText: "reviewing diff",
        },
      },
    });
    expect(ephemeral).toEqual({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.ephemeral",
      sessionId: "session-1",
      event: {
        type: "ephemeral-agent.thread-update",
        contextId: "ephemeral-1",
        threadId: "thread-1",
        update: {
          costTotal: 0,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindowUsageTokens: 3,
            contextWindow: 400000,
          },
          lastActivityText: "reviewing diff",
        },
      },
    });
    expect(parseSessionProtocolOutgoingLine(JSON.stringify(ephemeral))).toEqual({
      ok: true,
      message: ephemeral,
    });

    const contentDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 2,
      toRevision: 3,
      reason: "assistant-stream",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "message.content.append",
            messageId: "assistant-entry-1",
            text: " world",
            thinking: " more",
            timestamp: 2,
          },
        ],
      },
    });
    const patchedSnapshot = applySessionProtocolDelta(
      createProtocolSnapshot({
        sessionId: "session-1",
        revision: 2,
        lifecycle: "running",
        messages: [
          {
            id: "system",
            state: "committed",
            modelVisible: true,
            message: { role: "system", content: "system prompt", timestamp: 0 },
          },
          {
            id: "assistant-entry-1",
            state: "draft",
            modelVisible: false,
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "some" },
                { type: "text", text: "hello" },
              ],
              timestamp: 1,
            },
          },
        ],
      }),
      contentDelta,
    );
    expect(patchedSnapshot.messages[1].message).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "some more" },
        { type: "text", text: "hello world" },
      ],
      timestamp: 2,
    });
    const lateThinkingDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 2,
      toRevision: 3,
      reason: "assistant-stream",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "message.content.append",
            messageId: "assistant-entry-1",
            thinking: "late thought",
            timestamp: 2,
          },
        ],
      },
    });
    const lateThinkingSnapshot = applySessionProtocolDelta(
      createProtocolSnapshot({
        sessionId: "session-1",
        revision: 2,
        lifecycle: "running",
        messages: [
          {
            id: "system",
            state: "committed",
            modelVisible: true,
            message: { role: "system", content: "system prompt", timestamp: 0 },
          },
          {
            id: "assistant-entry-1",
            state: "draft",
            modelVisible: false,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              timestamp: 1,
            },
          },
        ],
      }),
      lateThinkingDelta,
    );
    expect(lateThinkingSnapshot.messages[1].message.content).toEqual([
      { type: "thinking", thinking: "late thought" },
      { type: "text", text: "hello" },
    ]);

    const keyedSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 3,
      historyEntries: [
        {
          id: "assistant-entry-1",
          message: {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.5",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool-1",
                name: "bash",
                arguments: { command: "echo hi" },
              },
            ],
          },
        },
      ],
      tools: {
        "tool-1": {
          id: "tool-1",
          toolCallId: "tool-1",
          toolName: "bash",
          call: { messageId: "assistant-entry-1", contentIndex: 0 },
          status: "queued",
          facetIds: [],
        },
      },
      facets: {
        "tool-ui-tool-1": {
          id: "tool-ui-tool-1",
          subject: { type: "tool", id: "tool-1" },
          kind: "tau.tool-ui-events",
          version: 1,
          data: { events: [] },
        },
      },
      agents: {},
    });
    const keyedDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 3,
      toRevision: 4,
      reason: "tool-run",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "tool.set",
            tool: {
              ...keyedSnapshot.tools["tool-1"],
              status: "running",
              startedAt: 10,
              facetIds: ["tool-ui-tool-1"],
            },
          },
          {
            type: "facet.set",
            facet: {
              ...keyedSnapshot.facets["tool-ui-tool-1"],
              data: {
                events: [
                  {
                    type: "bash_started",
                    toolCallId: "tool-1",
                    command: "echo hi",
                    headerTarget: "echo hi",
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const keyedPatchedSnapshot = applySessionProtocolDelta(keyedSnapshot, keyedDelta);
    expect(keyedPatchedSnapshot).toEqual(
      expect.objectContaining({
        revision: 4,
        tools: expect.objectContaining({
          "tool-1": expect.objectContaining({
            status: "running",
            startedAt: 10,
          }),
        }),
        facets: expect.objectContaining({
          "tool-ui-tool-1": expect.objectContaining({
            data: {
              events: [
                expect.objectContaining({
                  type: "bash_started",
                  toolCallId: "tool-1",
                }),
              ],
            },
          }),
        }),
      }),
    );
    expect(keyedPatchedSnapshot.messages).toBe(keyedSnapshot.messages);
    expect(keyedPatchedSnapshot.timeline).toBe(keyedSnapshot.timeline);
    expect(keyedPatchedSnapshot.tools).not.toBe(keyedSnapshot.tools);
    expect(keyedPatchedSnapshot.facets).not.toBe(keyedSnapshot.facets);

    const invalidToolReferenceDelta = createSessionProtocolDeltaMessage({
      sessionId: "session-1",
      fromRevision: 3,
      toRevision: 4,
      reason: "tool-run",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "tool.set",
            tool: {
              ...keyedSnapshot.tools["tool-1"],
              call: { messageId: "missing-assistant", contentIndex: 0 },
            },
          },
        ],
      },
    });
    expect(() => applySessionProtocolDelta(keyedSnapshot, invalidToolReferenceDelta)).toThrow(
      "session delta produced an invalid snapshot",
    );

    expect(() =>
      applySessionProtocolDelta(
        createProtocolSnapshot({
          sessionId: "session-1",
          revision: 2,
          lifecycle: "idle",
          messages: [
            {
              id: "system",
              state: "committed",
              modelVisible: true,
              message: {
                role: "system",
                content: "system prompt",
                timestamp: 0,
              },
            },
            {
              id: "assistant-entry-1",
              state: "committed",
              modelVisible: true,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
                timestamp: 1,
              },
            },
          ],
        }),
        contentDelta,
      ),
    ).toThrow("message.content.append targets non-draft message");
    expect(() =>
      createSessionProtocolDeltaMessage({
        sessionId: "session-1",
        fromRevision: 2,
        toRevision: 3,
        reason: "assistant-stream",
        delta: {
          type: "snapshot.patch",
          changes: [
            {
              type: "message.content.append",
              messageId: "assistant-entry-1",
              timestamp: 2,
            },
          ],
        },
      }),
    ).toThrow("message.content.append requires text or thinking");
    expect(() =>
      createSessionProtocolDeltaMessage({
        sessionId: "session-1",
        fromRevision: 2,
        toRevision: 3,
        reason: "assistant-stream",
        delta: {
          type: "snapshot.patch",
          changes: [
            {
              type: "message.content.append",
              messageId: "assistant-entry-1",
              text: "",
              timestamp: 2,
            },
          ],
        },
      }),
    ).toThrow("message.content.append requires text or thinking");

    expect(() =>
      createSessionProtocolDeltaMessage({
        sessionId: "session-1",
        fromRevision: null,
        toRevision: 2,
        reason: "notice",
        delta: { type: "snapshot.patch", changes: [] },
      }),
    ).toThrow("session protocol delta message is invalid");
    expect(() =>
      createSessionProtocolDeltaMessage({
        sessionId: "session-1",
        fromRevision: 2,
        toRevision: 2,
        reason: "notice",
        delta: { type: "snapshot.patch", changes: [] },
      }),
    ).toThrow("snapshot.patch toRevision must be greater than fromRevision");
    expect(() =>
      createSessionProtocolDeltaMessage({
        sessionId: "",
        fromRevision: 1,
        toRevision: 2,
        reason: "notice",
        delta: { type: "snapshot.patch", changes: [] },
      }),
    ).toThrow("session protocol delta message is invalid");

    const successResponse = createSessionProtocolSuccessResponse("req-1", "session.interrupt", {
      interrupted: false,
      isTurnRunning: false,
    });
    expect(successResponse).toEqual({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "req-1",
      ok: true,
      result: { interrupted: false, isTurnRunning: false },
    });
    expect(
      createSessionProtocolSuccessResponse("req-2", "session.unobserve", {
        unobserved: true,
      }),
    ).toEqual({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "req-2",
      ok: true,
      result: { unobserved: true },
    });
    expect(() =>
      createSessionProtocolSuccessResponse("req-bad", "session.interrupt", {
        shutdown: true,
      }),
    ).toThrow("session.interrupt result is invalid");
    expect(() =>
      createSessionProtocolSuccessResponse("", "session.interrupt", {
        interrupted: false,
        isTurnRunning: false,
      }),
    ).toThrow("session protocol success response is invalid");

    const errorResponse = createSessionProtocolErrorResponse(
      "req-2",
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      "bad request",
    );
    expect(errorResponse).toEqual({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "req-2",
      ok: false,
      error: {
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: "bad request",
      },
    });
    expect(() =>
      createSessionProtocolErrorResponse("req-bad", "not-a-code", "bad request"),
    ).toThrow("session protocol error response is invalid");
  });
});
