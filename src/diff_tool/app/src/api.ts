import type {
  BootstrapPayload,
  CreateThreadPayload,
  DiffReviewGetDiffResult,
  StateResponse,
  ThreadReplyPayload,
} from "./types.js";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...options.headers },
    ...options,
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string }).error ||
        response.statusText ||
        "request failed",
    );
  }
  return payload as T;
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

export async function updateReviewState(payload: {
  diffStyle?: "unified" | "split";
  sidebarOpen?: boolean;
  collapsedFileIds?: string[];
  viewedFileIds?: string[];
}): Promise<StateResponse> {
  return request<StateResponse>("/api/state", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createThread(
  payload: CreateThreadPayload,
): Promise<StateResponse> {
  return request<StateResponse>("/api/thread", {
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

export async function deleteThread(id: string): Promise<StateResponse> {
  return request<StateResponse>("/api/thread/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function requestThreadMessage(id: string): Promise<StateResponse> {
  return request<StateResponse>("/api/thread-message", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function returnReview(): Promise<{ status: string }> {
  return request<{ status: string }>("/api/review", {
    method: "POST",
  });
}

export async function cancelReview(): Promise<{ status: string }> {
  return request<{ status: string }>("/api/cancel", { method: "POST" });
}
