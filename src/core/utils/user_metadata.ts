import { Buffer } from "node:buffer";
import type { Message } from "@mariozechner/pi-ai";

export const TAU_USER_METADATA_PREFIX = "\u001eTAU_METADATA_V1:";
const TAU_USER_METADATA_SUFFIX = "\u001e";

export type TauCompactionUserMetadata = {
  type: "compaction";
  version: 1;
  summary: string;
};

export type TauUserMetadata = TauCompactionUserMetadata;

export type TauUserMetadataSplit = {
  metadata: TauUserMetadata[];
  visibleText: string;
};

function encodeMetadata(metadata: readonly TauUserMetadata[]): string {
  const json = JSON.stringify(metadata);
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeMetadata(encoded: string): TauUserMetadata[] {
  let parsed: unknown;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`invalid tau user metadata: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("invalid tau user metadata: payload must be an array");
  }

  return parsed.map(parseMetadataRecord);
}

function parseMetadataRecord(value: unknown): TauUserMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("invalid tau user metadata: record must be an object");
  }

  const record = value as Record<string, unknown>;
  if (record.type !== "compaction") {
    throw new Error("invalid tau user metadata: unknown record type");
  }
  if (record.version !== 1) {
    throw new Error("invalid tau user metadata: unsupported compaction metadata version");
  }
  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    throw new Error("invalid tau user metadata: compaction summary must be a non-empty string");
  }
  return {
    type: "compaction",
    version: 1,
    summary: record.summary,
  };
}

export function splitTauUserMetadata(text: string): TauUserMetadataSplit {
  if (!text.startsWith(TAU_USER_METADATA_PREFIX)) {
    return { metadata: [], visibleText: text };
  }

  const payloadStart = TAU_USER_METADATA_PREFIX.length;
  const payloadEnd = text.indexOf(TAU_USER_METADATA_SUFFIX, payloadStart);
  if (payloadEnd < 0) {
    throw new Error("invalid tau user metadata: missing metadata terminator");
  }

  const encoded = text.slice(payloadStart, payloadEnd);
  if (!encoded) {
    throw new Error("invalid tau user metadata: empty payload");
  }

  return {
    metadata: decodeMetadata(encoded),
    visibleText: text.slice(payloadEnd + TAU_USER_METADATA_SUFFIX.length),
  };
}

export function stripTauUserMetadata(text: string): string {
  return splitTauUserMetadata(text).visibleText;
}

export function prependTauUserMetadata(
  visibleText: string,
  metadata: readonly TauUserMetadata[],
): string {
  if (metadata.length === 0) {
    return visibleText;
  }

  const existing = splitTauUserMetadata(visibleText);
  return `${TAU_USER_METADATA_PREFIX}${encodeMetadata([...metadata, ...existing.metadata])}${TAU_USER_METADATA_SUFFIX}${existing.visibleText}`;
}

function splitMessageText(message: Message): TauUserMetadataSplit | undefined {
  if (message.role !== "user") {
    return undefined;
  }

  if (typeof message.content === "string") {
    return splitTauUserMetadata(message.content);
  }

  const firstBlock = message.content[0];
  if (typeof firstBlock === "string") {
    return splitTauUserMetadata(firstBlock);
  }
  if (firstBlock?.type === "text") {
    return splitTauUserMetadata(firstBlock.text ?? "");
  }

  return { metadata: [], visibleText: "" };
}

export function getTauUserMetadataFromMessage(message: Message): TauUserMetadata[] {
  return splitMessageText(message)?.metadata ?? [];
}

export function getCompactionMetadataFromMessage(
  message: Message,
): TauCompactionUserMetadata | undefined {
  return getTauUserMetadataFromMessage(message)
    .filter((metadata): metadata is TauCompactionUserMetadata => metadata.type === "compaction")
    .at(-1);
}

export function stripTauUserMetadataFromMessage(message: Message): Message {
  if (message.role !== "user") {
    return message;
  }

  if (typeof message.content === "string") {
    const visibleText = stripTauUserMetadata(message.content);
    if (visibleText === message.content) {
      return message;
    }
    return { ...message, content: visibleText };
  }

  const firstBlock = message.content[0];
  if (typeof firstBlock === "string") {
    const visibleText = stripTauUserMetadata(firstBlock);
    if (visibleText === firstBlock) {
      return message;
    }
    const content = [...message.content] as unknown[];
    content[0] = visibleText;
    return { ...message, content } as Message;
  }
  if (firstBlock?.type === "text") {
    const visibleText = stripTauUserMetadata(firstBlock.text ?? "");
    if (visibleText === firstBlock.text) {
      return message;
    }
    const content = [...message.content];
    content[0] = { ...firstBlock, text: visibleText };
    return { ...message, content };
  }

  return message;
}
