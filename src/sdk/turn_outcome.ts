import type { TauSdkSessionSnapshotResult, TauSdkSessionTurnOutcome } from "./types.js";

export function getTauSdkSessionTurnOutcome(
  snapshot: TauSdkSessionSnapshotResult,
  userHistoryEntryId: string,
): TauSdkSessionTurnOutcome | undefined {
  const message = snapshot.messages.find((candidate) => candidate.id === userHistoryEntryId);
  return message?.message.role === "user" ? message.turn : undefined;
}
