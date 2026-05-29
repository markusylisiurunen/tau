import type {
  BootstrapPayload,
  CollapseThreadPayload,
  CreateThreadPayload,
  CreateThreadResponse,
  DiffReviewGetDiffResult,
  GenerateBriefResponse,
  ResolveThreadPayload,
  ReviewStatePatch,
  StateResponse,
  ThreadReplyPayload,
} from "./types.js";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...options.headers },
    ...options,
  });
  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      (payload as { error?: string }).error ||
        response.statusText ||
        `request to ${path} failed`,
    );
  }

  return payload as T;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("server returned an invalid JSON response");
  }
}

export async function fetchBootstrap(): Promise<BootstrapPayload> {
  return request<BootstrapPayload>("/api/bootstrap");
}

export async function fetchDiff(
  path?: string,
): Promise<DiffReviewGetDiffResult> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
  return request<DiffReviewGetDiffResult>(`/api/diff${suffix}`);
}

export async function updateReviewState(
  payload: ReviewStatePatch,
): Promise<StateResponse> {
  return request<StateResponse>("/api/state", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createThread(
  payload: CreateThreadPayload,
): Promise<CreateThreadResponse> {
  return request<CreateThreadResponse>("/api/thread", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function replyToThread(
  payload: ThreadReplyPayload,
): Promise<StateResponse> {
  return request<StateResponse>("/api/thread/reply", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function requestThreadMessage(id: string): Promise<StateResponse> {
  return request<StateResponse>("/api/thread-message", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function resolveThread(
  payload: ResolveThreadPayload,
): Promise<StateResponse> {
  return request<StateResponse>("/api/thread/resolve", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function collapseThread(
  payload: CollapseThreadPayload,
): Promise<StateResponse> {
  return request<StateResponse>("/api/thread/collapse", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function generateBrief(): Promise<GenerateBriefResponse> {
  return request<GenerateBriefResponse>("/api/brief/generate", {
    method: "POST",
  });
}

export async function returnReview(
  message: string,
): Promise<{ status: string }> {
  return request<{ status: string }>("/api/review", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function cancelReview(): Promise<{ status: string }> {
  return request<{ status: string }>("/api/cancel", { method: "POST" });
}
