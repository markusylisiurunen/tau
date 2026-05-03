import { describe, expect, it } from "vitest";
import {
  CORE_EVENT_VERSION,
  parseCoreEvent,
  parseCoreEventEnvelope,
  safeParseCoreEvent,
  safeParseCoreEventEnvelope,
  wrapCoreEvent,
} from "../dist/core/events/index.js";
import {
  createRpcErrorResponse,
  createRpcEventMessage,
  createRpcReadyMessage,
  createRpcSuccessResponse,
  parseRpcOutgoingLine,
  parseRpcRequestLine,
  RPC_ERROR_CODES,
  RPC_METHODS,
  RPC_PROTOCOL_VERSION,
  validateRpcParams,
} from "../dist/core/modes/rpc_protocol.js";

describe("rpc_protocol", () => {
  it("parses valid request lines", () => {
    const parsed = parseRpcRequestLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "session.submit",
        params: { text: "hello" },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      request: {
        version: RPC_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "session.submit",
        params: { text: "hello" },
      },
    });
  });

  it("covers core event parser boundaries", () => {
    const event = { type: "notice", severity: "info", text: "ok" };

    expect(parseCoreEvent(event)).toEqual(event);
    expect(parseCoreEventEnvelope(wrapCoreEvent(event))).toEqual({
      version: CORE_EVENT_VERSION,
      event,
    });

    const compactionEnd = {
      type: "compaction_end",
      reason: "threshold",
      outcome: "compacted",
      result: {
        compactionMessage: "summary",
        cutType: "turn-boundary",
        retainedMessageCount: 3,
      },
    };
    expect(parseCoreEvent(compactionEnd)).toEqual(compactionEnd);

    expect(safeParseCoreEvent({ type: "notice", text: "missing severity" })).toEqual({
      ok: false,
      message: expect.stringContaining("invalid core event payload"),
    });
    expect(() => parseCoreEvent("bad")).toThrowError("core event payload must be an object");

    expect(
      safeParseCoreEventEnvelope({
        version: CORE_EVENT_VERSION,
        event: { type: "assistant_start" },
      }),
    ).toEqual({
      ok: false,
      message: expect.stringContaining("invalid core event envelope"),
    });

    expect(
      safeParseCoreEventEnvelope({
        version: 99,
        event: { type: "notice", severity: "info", text: "ok" },
      }),
    ).toEqual({
      ok: false,
      message: "unsupported core event version: 99",
    });
  });

  it("returns structured parse and validation errors", () => {
    const malformed = parseRpcRequestLine("{not-json}");
    expect(malformed.ok).toBe(false);
    expect(malformed.error.code).toBe(RPC_ERROR_CODES.parseError);

    const unknownMethod = parseRpcRequestLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "request",
        id: 2,
        method: "session.unknown",
        params: {},
      }),
    );
    expect(unknownMethod).toEqual({
      ok: false,
      id: 2,
      error: expect.objectContaining({ code: RPC_ERROR_CODES.methodNotFound }),
    });

    const invalidSubmit = parseRpcRequestLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "request",
        id: 3,
        method: "session.submit",
        params: { text: 123 },
      }),
    );
    expect(invalidSubmit).toEqual({
      ok: false,
      id: 3,
      error: expect.objectContaining({ code: RPC_ERROR_CODES.invalidParams }),
    });

    const requestWithUnsupportedFields = parseRpcRequestLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "request",
        id: 4,
        method: "session.submit",
        params: { text: "hello" },
        legacy: true,
      }),
    );
    expect(requestWithUnsupportedFields).toEqual({
      ok: false,
      id: 4,
      error: expect.objectContaining({
        code: RPC_ERROR_CODES.invalidRequest,
        message: "request contains unsupported top-level fields",
      }),
    });
  });

  it("returns structured parse errors for malformed outgoing messages", () => {
    const malformed = parseRpcOutgoingLine("{bad-json}");
    expect(malformed).toEqual({
      ok: false,
      reason: "parse_error",
      messageType: null,
      id: null,
      error: expect.objectContaining({ code: RPC_ERROR_CODES.parseError }),
    });

    const badVersion = parseRpcOutgoingLine(
      JSON.stringify({
        version: 99,
        type: "ready",
        sessionId: "session-1",
        methods: [...RPC_METHODS],
        coreEventVersion: CORE_EVENT_VERSION,
      }),
    );
    expect(badVersion).toEqual({
      ok: false,
      reason: "unsupported_version",
      messageType: null,
      id: null,
      error: expect.objectContaining({
        code: RPC_ERROR_CODES.invalidRequest,
        message: "unsupported rpc version: 99",
      }),
    });

    const malformedResponse = parseRpcOutgoingLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
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
      error: expect.objectContaining({ code: RPC_ERROR_CODES.invalidRequest }),
    });

    const responseWithUnsupportedFields = parseRpcOutgoingLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: "req-10",
        ok: true,
        result: { shutdown: true },
        error: { code: RPC_ERROR_CODES.internalError, message: "should not be here" },
      }),
    );
    expect(responseWithUnsupportedFields).toEqual({
      ok: false,
      reason: "invalid_payload",
      messageType: "response",
      id: "req-10",
      error: expect.objectContaining({
        code: RPC_ERROR_CODES.invalidRequest,
        message: "successful response must only include result payload",
      }),
    });
  });

  it("validates per-method params", () => {
    expect(validateRpcParams("initialize", { client: { name: "tau-sdk", version: "1" } })).toEqual({
      ok: true,
      value: {
        client: {
          name: "tau-sdk",
          version: "1",
        },
      },
    });

    const invalidInitialize = validateRpcParams("initialize", {});
    expect(invalidInitialize).toEqual({
      ok: false,
      error: expect.objectContaining({ code: RPC_ERROR_CODES.invalidParams }),
    });

    expect(
      validateRpcParams("initialize", {
        client: { name: "tau-sdk", version: "1", extra: true },
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: RPC_ERROR_CODES.invalidParams,
        message: "initialize.client must be an object with name/version strings",
      }),
    });

    expect(validateRpcParams("session.interrupt", {})).toEqual({ ok: true, value: {} });

    const invalidInterrupt = validateRpcParams("session.interrupt", { extra: true });
    expect(invalidInterrupt).toEqual({
      ok: false,
      error: expect.objectContaining({ code: RPC_ERROR_CODES.invalidParams }),
    });
  });

  it("builds ready/event/error messages with versioned envelopes", () => {
    const ready = createRpcReadyMessage({ sessionId: "session-1" });
    expect(ready).toEqual(
      expect.objectContaining({
        version: RPC_PROTOCOL_VERSION,
        type: "ready",
        sessionId: "session-1",
        coreEventVersion: CORE_EVENT_VERSION,
      }),
    );

    const event = createRpcEventMessage(
      wrapCoreEvent({ type: "notice", severity: "info", text: "ok" }),
      {
        requestId: "req-1",
      },
    );
    expect(event).toEqual({
      version: RPC_PROTOCOL_VERSION,
      type: "event",
      requestId: "req-1",
      event: {
        version: CORE_EVENT_VERSION,
        event: { type: "notice", severity: "info", text: "ok" },
      },
    });

    const successResponse = createRpcSuccessResponse("req-1", {
      interrupted: false,
      isTurnRunning: false,
    });
    expect(successResponse).toEqual({
      version: RPC_PROTOCOL_VERSION,
      type: "response",
      id: "req-1",
      ok: true,
      result: { interrupted: false, isTurnRunning: false },
    });

    const errorResponse = createRpcErrorResponse(
      "req-2",
      RPC_ERROR_CODES.invalidRequest,
      "bad request",
    );
    expect(errorResponse).toEqual({
      version: RPC_PROTOCOL_VERSION,
      type: "response",
      id: "req-2",
      ok: false,
      error: { code: RPC_ERROR_CODES.invalidRequest, message: "bad request" },
    });
  });
});
