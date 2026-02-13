import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";
import { describe, expect, it } from "vitest";

describe("sdk client integration", () => {
  it("connects to tau rpc, snapshots session state, and shuts down", async () => {
    const client = await createTauSdkClient({
      executable: process.execPath,
      scriptPath: "dist/main.js",
    });

    const unsubscribe = client.onEvent(() => {});

    try {
      expect(client.ready.version).toBe(1);
      expect(typeof client.ready.sessionId).toBe("string");
      expect(client.ready.sessionId.length).toBeGreaterThan(0);

      const snapshot = await client.snapshot();
      expect(snapshot.sessionId).toBe(client.ready.sessionId);
      expect(snapshot.isTurnRunning).toBe(false);
      expect(snapshot.historyLength).toBeGreaterThanOrEqual(0);

      const shutdown = await client.shutdown();
      expect(shutdown).toEqual({ shutdown: true });
    } finally {
      unsubscribe();
      await client.close();
    }
  }, 20_000);
});
