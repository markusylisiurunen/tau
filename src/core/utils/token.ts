import { Buffer } from "node:buffer";
import type { Message } from "@earendil-works/pi-ai";
import { assertNever } from "./never.js";

// this is not accurate, but it's a good-enough estimate. OpenAI suggests 4 bytes per token as a
// cheap heuristic, but in practice it seems to be slightly too low. we use 6 bytes per token, which
// is a good enough safeguard.
// see: https://cookbook.openai.com/examples/gpt-5/gpt-5-1-codex-max_prompting_guide
export const BYTES_PER_TOKEN = 6;

// Tau caps images at 2000x2000; this rounds up Anthropic's 4,784-token high-resolution cap.
const IMAGE_TOKEN_ESTIMATE = 5_000;

export function tokensToBytes(tokens: number): number {
  return tokens * BYTES_PER_TOKEN;
}

export function bytesToTokens(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
  let imageCount = 0;
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map((block) => {
          switch (block.type) {
            case "text":
            case "thinking":
            case "toolCall":
              return block;
            case "image":
              imageCount += 1;
              return { ...block, data: "" };
            default:
              return assertNever(block);
          }
        });
  const bytes = Buffer.byteLength(JSON.stringify({ ...message, content }), "utf8");
  return Math.max(1, bytesToTokens(bytes) + imageCount * IMAGE_TOKEN_ESTIMATE);
}

export function formatTokenEstimate(bytes: number): string {
  const tokens = Math.max(0, bytesToTokens(bytes));
  const label = tokens === 1 ? "token" : "tokens";
  return `~${tokens} ${label}`;
}
