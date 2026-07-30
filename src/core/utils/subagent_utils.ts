import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolUiEvent } from "../tools/registry.js";
import { extractAssistantText } from "./messages.js";

export function normalizeOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function getToolResultFirstLine(toolResult: ToolResultMessage): string {
  const text = toolResult.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return normalizeOneLine(text.split("\n")[0] ?? "");
}

export function formatToolUiEventForProgress(uiEvent: ToolUiEvent): string | undefined {
  switch (uiEvent.type) {
    case "tool_call_blocked":
      return `tool blocked: ${uiEvent.toolName} (${normalizeOneLine(uiEvent.reason)})`;
    case "bash_started":
      return `bash running: ${uiEvent.command.replace(/\n/g, " ")}`;
    case "bash_execution":
      return uiEvent.exitCode !== null && uiEvent.exitCode !== 0
        ? `bash failed: $ ${uiEvent.command.replace(/\n/g, " ")} (exit ${uiEvent.exitCode})`
        : undefined;
    case "bash_blocked":
      return `bash blocked: $ ${uiEvent.command.replace(/\n/g, " ")} (${normalizeOneLine(uiEvent.reason)})`;
    case "bash_aborted":
      return `bash ${uiEvent.reason}: $ ${uiEvent.command.replace(/\n/g, " ")}`;
    case "code_mode_started":
      return `${uiEvent.toolName}: ${uiEvent.headerTarget}`;
    case "code_mode_finished":
      return uiEvent.status === "error"
        ? `${uiEvent.toolName} failed: ${uiEvent.headerTarget}`
        : undefined;
    case "code_mode_blocked":
      return `${uiEvent.toolName} blocked: ${uiEvent.headerTarget} (${normalizeOneLine(uiEvent.reason)})`;
    case "write_success":
      return `write: ${uiEvent.path}`;
    case "write_blocked":
      return `tool blocked: write ${uiEvent.path} (${normalizeOneLine(uiEvent.reason)})`;
    case "edit_success":
      return `edit: ${uiEvent.path}`;
    case "edit_blocked":
      return `tool blocked: edit ${uiEvent.path} (${normalizeOneLine(uiEvent.reason)})`;
    case "view_image_success":
      return `view image: ${uiEvent.path}`;
    case "view_image_blocked":
      return `tool blocked: view image ${uiEvent.path} (${normalizeOneLine(uiEvent.reason)})`;
    default:
      return undefined;
  }
}

export function extractAssistantTextForProgress(message: AssistantMessage): string | undefined {
  const text = extractAssistantText(message).trim();
  const firstLine = text.split("\n")[0];
  return firstLine ? `agent: ${firstLine}` : undefined;
}

export class AsyncUiEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(event: T): void {
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) {
      next({ value: event, done: false });
      return;
    }
    this.buffered.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      },
    };
  }
}
