import { z } from "zod";
import type { DiffReviewFile } from "./snapshot.js";

export const DIFF_REVIEW_PROTOCOL_VERSION = 1 as const;

export const DIFF_REVIEW_METHODS = [
  "initialize",
  "session.get_context",
  "session.list_files",
  "session.get_diff",
  "session.set_ui_text",
  "thread.submit_message",
  "session.return_review",
  "session.cancel",
] as const;

export type DiffReviewMethod = (typeof DIFF_REVIEW_METHODS)[number];

export const DIFF_REVIEW_ERROR_CODES = {
  parseError: "parse_error",
  invalidRequest: "invalid_request",
  methodNotFound: "method_not_found",
  invalidParams: "invalid_params",
  unauthorized: "unauthorized",
  notInitialized: "not_initialized",
  sessionClosed: "session_closed",
  internalError: "internal_error",
} as const;

export type DiffReviewErrorCode =
  (typeof DIFF_REVIEW_ERROR_CODES)[keyof typeof DIFF_REVIEW_ERROR_CODES];

export type DiffReviewRequestId = string | number;

export type DiffReviewInitializeParams = {
  token: string;
};

export type DiffReviewSessionGetContextParams = Record<string, never>;
export type DiffReviewSessionListFilesParams = Record<string, never>;
export type DiffReviewSessionGetDiffParams = {
  path?: string;
};
export type DiffReviewSessionSetUiTextParams = {
  text: string;
};
export type DiffReviewThreadSubmitMessageParams = {
  threadId?: string;
  message: string;
};
export type DiffReviewSessionReturnReviewParams = {
  review: string;
};
export type DiffReviewSessionCancelParams = Record<string, never>;

export type DiffReviewParamsByMethod = {
  initialize: DiffReviewInitializeParams;
  "session.get_context": DiffReviewSessionGetContextParams;
  "session.list_files": DiffReviewSessionListFilesParams;
  "session.get_diff": DiffReviewSessionGetDiffParams;
  "session.set_ui_text": DiffReviewSessionSetUiTextParams;
  "thread.submit_message": DiffReviewThreadSubmitMessageParams;
  "session.return_review": DiffReviewSessionReturnReviewParams;
  "session.cancel": DiffReviewSessionCancelParams;
};

export type DiffReviewResultStatus = "returned" | "cancelled";

export type DiffReviewInitializeResult = {
  protocolVersion: typeof DIFF_REVIEW_PROTOCOL_VERSION;
  sessionId: string;
  methods: DiffReviewMethod[];
  alreadyInitialized: boolean;
};

export type DiffReviewSessionContextResult = {
  sessionId: string;
  repoRoot: string;
  cwd: string;
  diffArgs: string[];
  diffCommand: string;
};

export type DiffReviewSessionListFilesResult = {
  files: DiffReviewFile[];
};

export type DiffReviewSessionGetDiffResult =
  | {
      scope: "session";
      patch: string;
    }
  | {
      scope: "file";
      path: string;
      patch: string;
    };

export type DiffReviewSessionSetUiTextResult = {
  status: "updated";
};

export type DiffReviewThreadSubmitMessageResult = {
  threadId: string;
  response: string;
};

export type DiffReviewSessionReturnReviewResult = {
  status: Extract<DiffReviewResultStatus, "returned">;
};

export type DiffReviewSessionCancelResult = {
  status: Extract<DiffReviewResultStatus, "cancelled">;
};

export type DiffReviewResultByMethod = {
  initialize: DiffReviewInitializeResult;
  "session.get_context": DiffReviewSessionContextResult;
  "session.list_files": DiffReviewSessionListFilesResult;
  "session.get_diff": DiffReviewSessionGetDiffResult;
  "session.set_ui_text": DiffReviewSessionSetUiTextResult;
  "thread.submit_message": DiffReviewThreadSubmitMessageResult;
  "session.return_review": DiffReviewSessionReturnReviewResult;
  "session.cancel": DiffReviewSessionCancelResult;
};

export type DiffReviewRequestMessage = {
  [M in DiffReviewMethod]: {
    version: typeof DIFF_REVIEW_PROTOCOL_VERSION;
    type: "request";
    id: DiffReviewRequestId;
    method: M;
    params: DiffReviewParamsByMethod[M];
  };
}[DiffReviewMethod];

export type DiffReviewError = {
  code: DiffReviewErrorCode;
  message: string;
  data?: unknown;
};

export type DiffReviewSuccessResponseMessage = {
  version: typeof DIFF_REVIEW_PROTOCOL_VERSION;
  type: "response";
  id: DiffReviewRequestId;
  ok: true;
  result: DiffReviewResultByMethod[DiffReviewMethod];
};

export type DiffReviewErrorResponseMessage = {
  version: typeof DIFF_REVIEW_PROTOCOL_VERSION;
  type: "response";
  id: DiffReviewRequestId | null;
  ok: false;
  error: DiffReviewError;
};

export type DiffReviewResponseMessage =
  | DiffReviewSuccessResponseMessage
  | DiffReviewErrorResponseMessage;

export type DiffReviewParseFailure = {
  ok: false;
  id: DiffReviewRequestId | null;
  error: DiffReviewError;
};

export type DiffReviewParseSuccess = {
  ok: true;
  request: DiffReviewRequestMessage;
};

export type DiffReviewParseResult = DiffReviewParseFailure | DiffReviewParseSuccess;

export type DiffReviewParamsValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DiffReviewError };

const EMPTY_OBJECT = Object.freeze({}) as Record<string, never>;

const diffReviewMethodSchema = z.enum(DIFF_REVIEW_METHODS);
const diffReviewRequestIdSchema = z.union([z.string(), z.number()]);
const diffReviewRequestEnvelopeSchema = z
  .object({
    version: z.literal(DIFF_REVIEW_PROTOCOL_VERSION),
    type: z.literal("request"),
    id: diffReviewRequestIdSchema,
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();
const diffReviewIdFieldSchema = z.object({ id: z.unknown() }).passthrough();
const diffReviewVersionFieldSchema = z.object({ version: z.unknown() }).passthrough();
const diffReviewTypeFieldSchema = z.object({ type: z.unknown() }).passthrough();
const emptyObjectSchema = z.object({}).strict();

const initializeParamsSchema = z
  .object({
    token: z.string().trim().min(1),
  })
  .strict();
const sessionGetDiffParamsSchema = z
  .object({
    path: z.string().min(1).optional(),
  })
  .strict();
const sessionSetUiTextParamsSchema = z
  .object({
    text: z.string(),
  })
  .strict();
const threadSubmitMessageParamsSchema = z
  .object({
    threadId: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1),
  })
  .strict();
const sessionReturnReviewParamsSchema = z
  .object({
    review: z.string().trim().min(1),
  })
  .strict();

export function createDiffReviewError(
  code: DiffReviewErrorCode,
  message: string,
  data?: unknown,
): DiffReviewError {
  return data === undefined ? { code, message } : { code, message, data };
}

export function createDiffReviewSuccessResponse<M extends DiffReviewMethod>(
  id: DiffReviewRequestId,
  result: DiffReviewResultByMethod[M],
): DiffReviewSuccessResponseMessage {
  return {
    version: DIFF_REVIEW_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result,
  };
}

export function createDiffReviewErrorResponse(
  id: DiffReviewRequestId | null,
  code: DiffReviewErrorCode,
  message: string,
  data?: unknown,
): DiffReviewErrorResponseMessage {
  return {
    version: DIFF_REVIEW_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: createDiffReviewError(code, message, data),
  };
}

export function serializeDiffReviewMessage(message: DiffReviewResponseMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function validateDiffReviewParams<M extends DiffReviewMethod>(
  method: M,
  raw: unknown,
): DiffReviewParamsValidationResult<DiffReviewParamsByMethod[M]> {
  const parsed = (() => {
    switch (method) {
      case "initialize":
        return initializeParamsSchema.safeParse(raw);
      case "session.get_context":
      case "session.list_files":
      case "session.cancel":
        return emptyObjectSchema.safeParse(raw ?? EMPTY_OBJECT);
      case "session.get_diff":
        return sessionGetDiffParamsSchema.safeParse(raw ?? EMPTY_OBJECT);
      case "session.set_ui_text":
        return sessionSetUiTextParamsSchema.safeParse(raw);
      case "thread.submit_message":
        return threadSubmitMessageParamsSchema.safeParse(raw);
      case "session.return_review":
        return sessionReturnReviewParamsSchema.safeParse(raw);
    }
  })();

  if (parsed.success) {
    return {
      ok: true,
      value: parsed.data as DiffReviewParamsByMethod[M],
    };
  }

  return {
    ok: false,
    error: createDiffReviewError(
      DIFF_REVIEW_ERROR_CODES.invalidParams,
      formatParamsError(method, parsed.error),
    ),
  };
}

export function parseDiffReviewRequestLine(line: string): DiffReviewParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(DIFF_REVIEW_ERROR_CODES.parseError, "request line is empty"),
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed) as unknown;
  } catch (error) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.parseError,
        "failed to parse request json",
        { cause: error instanceof Error ? error.message : String(error) },
      ),
    };
  }

  const versionField = diffReviewVersionFieldSchema.safeParse(decoded);
  if (!versionField.success) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        "request must include numeric version field",
      ),
    };
  }

  if (versionField.data.version !== DIFF_REVIEW_PROTOCOL_VERSION) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        `unsupported diff review protocol version: ${String(versionField.data.version)}`,
      ),
    };
  }

  const typeField = diffReviewTypeFieldSchema.safeParse(decoded);
  if (!typeField.success || typeField.data.type !== "request") {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        "message type must be 'request'",
      ),
    };
  }

  const idField = diffReviewIdFieldSchema.safeParse(decoded);
  const parsedId = idField.success ? diffReviewRequestIdSchema.safeParse(idField.data.id) : null;
  const requestId = parsedId?.success ? parsedId.data : null;

  const envelope = diffReviewRequestEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    const hasMethod = envelope.error.issues.some((issue) => issue.path[0] === "method");
    const message = hasMethod
      ? "request must include string method field"
      : "request contains unsupported or invalid top-level fields";
    return {
      ok: false,
      id: requestId,
      error: createDiffReviewError(DIFF_REVIEW_ERROR_CODES.invalidRequest, message),
    };
  }

  const parsedMethod = diffReviewMethodSchema.safeParse(envelope.data.method);
  if (!parsedMethod.success) {
    return {
      ok: false,
      id: envelope.data.id,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.methodNotFound,
        `unknown diff review method '${envelope.data.method}'`,
      ),
    };
  }

  const paramsResult = validateDiffReviewParams(
    parsedMethod.data,
    envelope.data.params ?? EMPTY_OBJECT,
  );
  if (!paramsResult.ok) {
    return {
      ok: false,
      id: envelope.data.id,
      error: paramsResult.error,
    };
  }

  return {
    ok: true,
    request: {
      version: DIFF_REVIEW_PROTOCOL_VERSION,
      type: "request",
      id: envelope.data.id,
      method: parsedMethod.data,
      params: paramsResult.value,
    } as DiffReviewRequestMessage,
  };
}

function formatParamsError(method: DiffReviewMethod, _error: z.ZodError): string {
  switch (method) {
    case "initialize":
      return "initialize.token must be a non-empty string";
    case "session.get_context":
    case "session.list_files":
    case "session.cancel":
      return `${method} does not accept parameters`;
    case "session.get_diff":
      return "session.get_diff.path must be a non-empty string when provided";
    case "session.set_ui_text":
      return "session.set_ui_text.text must be a string";
    case "thread.submit_message":
      return "thread.submit_message requires a non-empty message and optional non-empty threadId";
    case "session.return_review":
      return "session.return_review.review must be a non-empty string";
  }
}
