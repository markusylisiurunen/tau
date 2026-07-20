import type { TauSdkSessionSnapshotResult, TauSdkSessionTurnOutcome } from "./types.js";

export function getTauSdkSessionTurnOutcome(
  snapshot: TauSdkSessionSnapshotResult,
  userHistoryEntryId: string,
): TauSdkSessionTurnOutcome | undefined {
  return snapshot.messages.find((message) => message.id === userHistoryEntryId)?.turn;
}
