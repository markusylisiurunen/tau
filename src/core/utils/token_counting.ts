import { z } from "zod";
import type { TokenCountingMethod } from "../config/schema.js";
import { bytesToTokens } from "./token.js";
import {
  type TokenTruncationStrategy,
  type TruncationResult,
  truncateForTokens,
  truncateToBytesFromEnd,
  truncateToBytesFromStart,
} from "./truncate.js";
import { formatZodError } from "./zod.js";

const DEFAULT_TOKEN_COUNTING_METHOD: TokenCountingMethod = "heuristic";
const ANTHROPIC_TOKEN_COUNTING_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const TRUNCATED_TOKENS_MARKER_SUFFIX = " tokens truncated…";

const anthropicCountTokensResponseSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
});

export interface TokenCountedTruncationResult extends TruncationResult {
  totalTokens: number;
  outputTokens: number;
  truncatedTokens: number;
}

export interface TokenCounter {
  readonly method: TokenCountingMethod;
  countTextTokens(text: string): Promise<number>;
  truncateTextToTokens(
    content: string,
    options: { maxTokens: number; strategy?: TokenTruncationStrategy },
  ): Promise<TokenCountedTruncationResult>;
}

export function resolveTokenCountingMethod(
  method: TokenCountingMethod | undefined,
): TokenCountingMethod {
  return method ?? DEFAULT_TOKEN_COUNTING_METHOD;
}

export async function validateTokenCounterConfiguration(args: {
  method: TokenCountingMethod | undefined;
  getAnthropicApiKey: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  const method = resolveTokenCountingMethod(args.method);
  if (method !== "anthropic") {
    return undefined;
  }

  const apiKey = await args.getAnthropicApiKey();
  if (apiKey) {
    return undefined;
  }

  return "tokenCounting 'anthropic' requires an Anthropic API key.";
}

export function createTokenCounter(args: {
  method: TokenCountingMethod | undefined;
  getAnthropicApiKey: () => Promise<string | undefined>;
}): TokenCounter {
  const method = resolveTokenCountingMethod(args.method);
  if (method === "anthropic") {
    return new AnthropicTokenCounter(args.getAnthropicApiKey);
  }
  return new HeuristicTokenCounter();
}

class HeuristicTokenCounter implements TokenCounter {
  readonly method = "heuristic" satisfies TokenCountingMethod;

  async countTextTokens(text: string): Promise<number> {
    return Math.max(0, bytesToTokens(Buffer.byteLength(text, "utf-8")));
  }

  async truncateTextToTokens(
    content: string,
    options: { maxTokens: number; strategy?: TokenTruncationStrategy },
  ): Promise<TokenCountedTruncationResult> {
    const truncation = truncateForTokens(content, options);
    const totalTokens = await this.countTextTokens(content);
    const outputTokens = truncation.truncated
      ? Math.min(totalTokens, options.maxTokens)
      : totalTokens;
    return {
      ...truncation,
      totalTokens,
      outputTokens,
      truncatedTokens: Math.max(0, totalTokens - outputTokens),
    };
  }
}

class AnthropicTokenCounter implements TokenCounter {
  readonly method = "anthropic" satisfies TokenCountingMethod;
  private readonly cache = new Map<string, Promise<number>>();
  private baselinePromise?: Promise<number>;
  private apiKeyPromise?: Promise<string>;

  constructor(private readonly getAnthropicApiKey: () => Promise<string | undefined>) {}

  async countTextTokens(text: string): Promise<number> {
    const cached = this.cache.get(text);
    if (cached) {
      return cached;
    }

    const countPromise = this.countTextTokensUncached(text);
    this.cache.set(text, countPromise);
    return countPromise;
  }

  async truncateTextToTokens(
    content: string,
    options: { maxTokens: number; strategy?: TokenTruncationStrategy },
  ): Promise<TokenCountedTruncationResult> {
    if (!content) {
      return {
        content: "",
        truncated: false,
        truncatedBy: null,
        totalLines: 0,
        totalBytes: 0,
        outputLines: 0,
        outputBytes: 0,
        maxLines: 0,
        maxTokens: options.maxTokens,
        totalTokens: 0,
        outputTokens: 0,
        truncatedTokens: 0,
      };
    }

    const totalTokens = await this.countTextTokens(content);
    const totalBytes = Buffer.byteLength(content, "utf-8");
    const totalLines = content.split("\n").length;
    if (totalTokens <= options.maxTokens) {
      return {
        content,
        truncated: false,
        truncatedBy: null,
        totalLines,
        totalBytes,
        outputLines: totalLines,
        outputBytes: totalBytes,
        maxLines: totalLines,
        maxTokens: options.maxTokens,
        totalTokens,
        outputTokens: totalTokens,
        truncatedTokens: 0,
      };
    }

    const strategy = options.strategy ?? "middle";
    const best = await this.findBestTruncationCandidate(content, options.maxTokens, strategy);
    const outputContent = buildTruncatedOutput({
      strategy,
      parts: best.parts,
      truncatedTokens: Math.max(1, totalTokens - best.keptTokens),
    });

    return {
      content: outputContent,
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: outputContent.split("\n").length,
      outputBytes: Buffer.byteLength(outputContent, "utf-8"),
      maxLines: totalLines,
      maxTokens: options.maxTokens,
      totalTokens,
      outputTokens: Math.min(totalTokens, options.maxTokens),
      truncatedTokens: Math.max(1, totalTokens - best.keptTokens),
    };
  }

  private async countTextTokensUncached(text: string): Promise<number> {
    const [baselineTokens, messageTokens] = await Promise.all([
      this.getBaselineTokens(),
      this.countMessageTokens(text),
    ]);
    return Math.max(0, messageTokens - baselineTokens);
  }

  private async getBaselineTokens(): Promise<number> {
    if (!this.baselinePromise) {
      this.baselinePromise = this.countMessageTokens("");
    }
    return this.baselinePromise;
  }

  private async countMessageTokens(text: string): Promise<number> {
    const apiKey = await this.getResolvedApiKey();
    const response = await fetch(`${ANTHROPIC_API_BASE_URL}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": ANTHROPIC_API_VERSION,
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: ANTHROPIC_TOKEN_COUNTING_MODEL,
        messages: [{ role: "user", content: text }],
      }),
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const details =
        extractAnthropicErrorMessage(parsed) || response.statusText || "Request failed.";
      throw new Error(`Anthropic token counting error (${response.status}): ${details}`);
    }

    const validated = anthropicCountTokensResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Anthropic token counting response parse error: ${formatZodError(validated.error)}`,
      );
    }

    return validated.data.input_tokens;
  }

  private async getResolvedApiKey(): Promise<string> {
    if (!this.apiKeyPromise) {
      this.apiKeyPromise = this.resolveApiKey();
    }
    return this.apiKeyPromise;
  }

  private async resolveApiKey(): Promise<string> {
    const apiKey = await this.getAnthropicApiKey();
    if (!apiKey) {
      throw new Error("Anthropic token counting requires an Anthropic API key.");
    }
    return apiKey;
  }

  private async findBestTruncationCandidate(
    content: string,
    maxTokens: number,
    strategy: TokenTruncationStrategy,
  ): Promise<{ parts: KeptContentParts; keptTokens: number }> {
    const totalBytes = Buffer.byteLength(content, "utf-8");
    let low = 0;
    let high = totalBytes;
    let bestParts: KeptContentParts = { head: "", tail: "" };
    let bestKeptTokens = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const parts = extractKeptContentParts({ content, keptBytes: mid, strategy });
      const candidate = buildTruncatedOutput({
        strategy,
        parts,
        truncatedTokens: 0,
      });
      const candidateTokens = await this.countTextTokens(candidate);
      if (candidateTokens <= maxTokens) {
        bestParts = parts;
        bestKeptTokens = await this.countTextTokens(`${parts.head}${parts.tail}`);
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return {
      parts: bestParts,
      keptTokens: bestKeptTokens,
    };
  }
}

function extractAnthropicErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const errorValue = (parsed as { error?: unknown }).error;
  if (!errorValue || typeof errorValue !== "object") {
    return undefined;
  }

  const message = (errorValue as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

type KeptContentParts = {
  head: string;
  tail: string;
};

function extractKeptContentParts(args: {
  content: string;
  keptBytes: number;
  strategy: TokenTruncationStrategy;
}): KeptContentParts {
  const { content, keptBytes, strategy } = args;
  if (keptBytes <= 0) {
    return { head: "", tail: "" };
  }

  if (strategy === "head") {
    return { head: truncateToBytesFromStart(content, keptBytes), tail: "" };
  }

  if (strategy === "tail") {
    return { head: "", tail: truncateToBytesFromEnd(content, keptBytes) };
  }

  const headBytes = Math.floor(keptBytes / 2);
  const tailBytes = keptBytes - headBytes;
  return {
    head: truncateToBytesFromStart(content, headBytes),
    tail: truncateToBytesFromEnd(content, tailBytes),
  };
}

function buildTruncatedOutput(args: {
  strategy: TokenTruncationStrategy;
  parts: KeptContentParts;
  truncatedTokens: number;
}): string {
  const marker = formatTruncatedTokensMarker(args.truncatedTokens);
  if (args.strategy === "head") {
    return `${args.parts.head}${marker}`;
  }
  if (args.strategy === "tail") {
    return `${marker}${args.parts.tail}`;
  }
  if (!args.parts.head && !args.parts.tail) {
    return marker;
  }
  return `${args.parts.head}${marker}${args.parts.tail}`;
}

function formatTruncatedTokensMarker(truncatedTokens: number): string {
  return `…${Math.max(0, truncatedTokens)}${TRUNCATED_TOKENS_MARKER_SUFFIX}`;
}
