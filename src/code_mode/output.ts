import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { DEFAULT_COMMAND_CAPTURE_BYTES } from "../core/tools/execution_backend.js";
import { tokensToBytes } from "../core/utils/token.js";
import { truncateToBytesFromEnd, truncateToBytesFromStart } from "../core/utils/truncate.js";

type ImageSlot = { type: "image"; value?: ImageContent };

export class CodeModeOutput {
  private parts: Array<TextContent | ImageSlot> = [];
  private textBytes = 0;

  appendText(text: string): void {
    if (!text) return;
    const last = this.parts.at(-1);
    if (last?.type === "text") last.text += text;
    else this.parts.push({ type: "text", text });
    this.textBytes += Buffer.byteLength(text);
    for (const part of this.parts) {
      if (this.textBytes <= DEFAULT_COMMAND_CAPTURE_BYTES) break;
      if (part.type !== "text") continue;
      const bytes = Buffer.byteLength(part.text);
      part.text = truncateToBytesFromEnd(
        part.text,
        Math.max(0, bytes - (this.textBytes - DEFAULT_COMMAND_CAPTURE_BYTES)),
      );
      this.textBytes -= bytes - Buffer.byteLength(part.text);
    }
  }

  get text(): string {
    return this.parts
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => stripAnsi(part.text))
      .join("");
  }

  reserveImage(): ImageSlot {
    const slot: ImageSlot = { type: "image" };
    this.parts.push(slot);
    return slot;
  }

  project(options: {
    terminationNote: string;
    projection: { content: string; truncated: boolean; maxTokens: number };
    footer: string;
  }): Array<TextContent | ImageContent> {
    const parts: Array<TextContent | ImageContent> = [];
    const append = (part: TextContent | ImageContent): void => {
      const last = parts.at(-1);
      if (part.type === "text" && last?.type === "text") last.text += part.text;
      else parts.push(part);
    };
    for (const part of this.parts) {
      if (part.type === "image") {
        if (part.value) append(part.value);
      } else if (part.text) {
        append({ type: "text", text: stripAnsi(part.text) });
      }
    }
    if (options.terminationNote) append({ type: "text", text: options.terminationNote });
    const text = parts
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    const totalBytes = Buffer.byteLength(text);
    const budget = tokensToBytes(options.projection.maxTokens);
    const head = options.projection.truncated
      ? truncateToBytesFromStart(text, Math.floor(budget / 2))
      : text;
    const tail = options.projection.truncated
      ? truncateToBytesFromEnd(text, budget - Math.floor(budget / 2))
      : "";
    const headEnd = Buffer.byteLength(head);
    const tailStart = totalBytes - Buffer.byteLength(tail);
    const marker = options.projection.truncated
      ? options.projection.content.slice(
          head.length,
          options.projection.content.length - tail.length,
        )
      : "";
    let offset = 0;
    let marked = false;
    const result: Array<TextContent | ImageContent> = [];
    for (const part of parts) {
      if (part.type === "image") {
        result.push(part);
        continue;
      }
      const bytes = Buffer.from(part.text);
      const end = offset + bytes.length;
      let retained = bytes
        .subarray(0, Math.max(0, Math.min(bytes.length, headEnd - offset)))
        .toString("utf8");
      if (marker && !marked && end > headEnd) {
        retained += marker;
        marked = true;
      }
      if (options.projection.truncated && end > tailStart) {
        retained += bytes.subarray(Math.max(0, tailStart - offset)).toString("utf8");
      }
      if (retained.trimEnd()) result.push({ type: "text", text: retained.trimEnd() });
      offset = end;
    }
    if (options.footer) {
      const last = result.at(-1);
      if (last?.type === "text") last.text += options.footer;
      else result.push({ type: "text", text: options.footer.trimStart() });
    }
    return result;
  }
}
