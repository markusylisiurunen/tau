import { describe, expect, it } from "vitest";
import {
  createDiffReviewErrorResponse,
  createDiffReviewSuccessResponse,
  DIFF_REVIEW_ERROR_CODES,
  DIFF_REVIEW_METHODS,
  DIFF_REVIEW_PROTOCOL_VERSION,
  parseDiffReviewRequestLine,
  serializeDiffReviewMessage,
  validateDiffReviewParams,
} from "../src/core/diff_review/protocol.ts";

describe("diff_review protocol", () => {
  it("parses valid request lines", () => {
    const parsed = parseDiffReviewRequestLine(
      JSON.stringify({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "thread.submit_message",
        params: {
          message: "Review this file",
          forkFromThreadId: "thread-0",
          reasoning: "medium",
        },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      request: {
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "thread.submit_message",
        params: {
          message: "Review this file",
          forkFromThreadId: "thread-0",
          reasoning: "medium",
        },
      },
    });
  });

  it("returns structured parse and validation errors", () => {
    expect(parseDiffReviewRequestLine("{bad-json}")).toEqual({
      ok: false,
      id: null,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.parseError }),
    });

    expect(
      parseDiffReviewRequestLine(
        JSON.stringify({
          version: DIFF_REVIEW_PROTOCOL_VERSION,
          type: "request",
          id: 1,
          method: "session.unknown",
          params: {},
        }),
      ),
    ).toEqual({
      ok: false,
      id: 1,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.methodNotFound }),
    });

    expect(
      parseDiffReviewRequestLine(
        JSON.stringify({
          version: DIFF_REVIEW_PROTOCOL_VERSION,
          type: "request",
          id: 2,
          method: "session.return_review",
          params: { outcome: "commented", review: "" },
        }),
      ),
    ).toEqual({
      ok: false,
      id: 2,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });
  });

  it("validates per-method params", () => {
    expect(validateDiffReviewParams("initialize", { token: "secret" })).toEqual({
      ok: true,
      value: { token: "secret" },
    });

    expect(validateDiffReviewParams("session.get_context", {})).toEqual({
      ok: true,
      value: {},
    });

    expect(validateDiffReviewParams("session.get_diff", { path: "src/a.ts" })).toEqual({
      ok: true,
      value: { path: "src/a.ts" },
    });

    expect(validateDiffReviewParams("session.get_diff", { path: " src/a.ts " })).toEqual({
      ok: true,
      value: { path: " src/a.ts " },
    });

    expect(validateDiffReviewParams("session.set_ui_text", { text: "ready" })).toEqual({
      ok: true,
      value: { text: "ready" },
    });

    expect(validateDiffReviewParams("session.return_review", { outcome: "approved" })).toEqual({
      ok: true,
      value: { outcome: "approved" },
    });

    expect(
      validateDiffReviewParams("session.return_review", {
        outcome: "commented",
        review: "Needs tests.",
      }),
    ).toEqual({
      ok: true,
      value: { outcome: "commented", review: "Needs tests." },
    });

    expect(
      validateDiffReviewParams("session.return_review", {
        review: "Needs tests.",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });

    expect(
      validateDiffReviewParams("thread.submit_message", {
        forkFromThreadId: "thread-1",
        message: "hi",
        reasoning: "medium",
      }),
    ).toEqual({
      ok: true,
      value: {
        forkFromThreadId: "thread-1",
        message: "hi",
        reasoning: "medium",
      },
    });

    expect(
      validateDiffReviewParams("thread.submit_message", { threadId: "", message: "hi" }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });

    expect(
      validateDiffReviewParams("thread.submit_message", {
        message: "hi",
        reasoning: "extreme",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });

    expect(
      validateDiffReviewParams("thread.submit_message", {
        threadId: "thread-1",
        forkFromThreadId: "thread-0",
        message: "hi",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: DIFF_REVIEW_ERROR_CODES.invalidParams }),
    });
  });

  it("serializes success and error responses", () => {
    const success = createDiffReviewSuccessResponse("req-1", {
      protocolVersion: DIFF_REVIEW_PROTOCOL_VERSION,
      sessionId: "session-1",
      methods: [...DIFF_REVIEW_METHODS],
      alreadyInitialized: false,
    });
    const failure = createDiffReviewErrorResponse(
      "req-2",
      DIFF_REVIEW_ERROR_CODES.unauthorized,
      "bad token",
    );

    expect(JSON.parse(serializeDiffReviewMessage(success))).toEqual(success);
    expect(JSON.parse(serializeDiffReviewMessage(failure))).toEqual(failure);
  });
});
