import { describe, expect, it } from "vitest";
import { CORE_EVENT_VERSION, wrapCoreEvent } from "../dist/core/events/types.js";
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
  });

  it("parses valid outgoing server messages", () => {
    const ready = parseRpcOutgoingLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "ready",
        sessionId: "session-1",
        methods: [...RPC_METHODS],
        coreEventVersion: CORE_EVENT_VERSION,
      }),
    );
    expect(ready).toEqual({
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "ready",
        sessionId: "session-1",
        methods: [...RPC_METHODS],
        coreEventVersion: CORE_EVENT_VERSION,
      },
    });

    const event = parseRpcOutgoingLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "event",
        requestId: "req-1",
        event: {
          version: CORE_EVENT_VERSION,
          event: { type: "notice", severity: "info", text: "hello" },
        },
      }),
    );
    expect(event).toEqual({
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "event",
        requestId: "req-1",
        event: {
          version: CORE_EVENT_VERSION,
          event: { type: "notice", severity: "info", text: "hello" },
        },
      },
    });

    const successResponse = parseRpcOutgoingLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: 7,
        ok: true,
        result: { shutdown: true },
      }),
    );
    expect(successResponse).toEqual({
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: 7,
        ok: true,
        result: { shutdown: true },
      },
    });

    const errorResponse = parseRpcOutgoingLine(
      JSON.stringify({
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: "req-2",
        ok: false,
        error: {
          code: RPC_ERROR_CODES.busy,
          message: "a session turn is already running",
        },
      }),
    );
    expect(errorResponse).toEqual({
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: "req-2",
        ok: false,
        error: {
          code: RPC_ERROR_CODES.busy,
          message: "a session turn is already running",
        },
      },
    });
  });

  it("returns structured parse errors for malformed outgoing messages", () => {
    const malformed = parseRpcOutgoingLine("{bad-json}");
    expect(malformed).toEqual({
      ok: false,
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
      messageType: "response",
      id: "req-9",
      error: expect.objectContaining({ code: RPC_ERROR_CODES.invalidRequest }),
    });
  });

  it("validates per-method params", () => {
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
