import {
  OPENROUTER_IMAGE_BYTES,
  OPENROUTER_MEDIA_BYTES,
  OPENROUTER_REQUEST_BYTES,
  type OpenRouterAttachment,
} from "./openrouter_media.js";

const MEMORY_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;
let reservedBytes = 0;
const waiters: Array<() => void> = [];

export async function withOpenRouterBudget<T>(
  attachments: OpenRouterAttachment[],
  textBytes: number,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const encodedBytes = Math.min(
    OPENROUTER_REQUEST_BYTES,
    textBytes +
      attachments.reduce((total, attachment) => {
        const bytes = attachment.kind === "image" ? OPENROUTER_IMAGE_BYTES : OPENROUTER_MEDIA_BYTES;
        return total + (attachment.data?.length ?? 4 * Math.ceil(bytes / 3));
      }, 0),
  );
  // Reserve for raw bytes, base64, UTF-16 serialization and transport copies, plus
  // image decoding and response parsing. Path inputs reserve their maximum size.
  const reservation = encodedBytes * 6 + 768 * 1024 * 1024;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      const index = waiters.indexOf(acquire);
      if (index !== -1) waiters.splice(index, 1);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
      for (const waiter of [...waiters]) waiter();
    };
    const acquire = () => {
      if (signal.aborted) return abort();
      if (waiters[0] !== acquire || reservedBytes + reservation > MEMORY_BUDGET_BYTES) return;
      reservedBytes += reservation;
      cleanup();
      resolve();
    };
    waiters.push(acquire);
    signal.addEventListener("abort", abort, { once: true });
    acquire();
  });
  try {
    signal.throwIfAborted();
    return await run();
  } finally {
    reservedBytes -= reservation;
    for (const waiter of [...waiters]) waiter();
  }
}
