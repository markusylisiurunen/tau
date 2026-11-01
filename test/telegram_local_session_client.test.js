import { describe, expect, it, vi } from "vitest";
import { createLocalTelegramSessionClient } from "../dist/core/telegram/local_session_client.js";
import { createTelegramFileTools } from "../dist/core/telegram/send_file.js";

describe("local Telegram session client", () => {
  it("passes programmatic tools and host configuration to the SDK client", async () => {
    const client = { sessions: {}, close: vi.fn(async () => {}) };
    const createSdkClient = vi.fn(async () => client);
    const hostConfig = { history: { endpoint: "https://history.example.com" } };
    const remoteModelCatalog = { snapshot: vi.fn(() => new Map()) };
    const clientTools = createTelegramFileTools(
      {
        sendPhoto: vi.fn(),
        sendVideo: vi.fn(),
        sendAudio: vi.fn(),
        sendDocument: vi.fn(),
      },
      123,
    );

    const result = await createLocalTelegramSessionClient({
      client: {
        cwd: "/workspace",
        ownerId: "telegram:bot:chat:123",
        clientTools,
        persona: "gpt-5.6-sol-coder",
      },
      hostConfig,
      remoteModelCatalog,
      deps: { createSdkClient },
    });

    expect(result).toBe(client);
    expect(createSdkClient).toHaveBeenCalledExactlyOnceWith(
      {
        cwd: "/workspace",
        persona: "gpt-5.6-sol-coder",
        initialize: { client: { name: "tau-telegram", version: "1" } },
        clientTools,
      },
      hostConfig,
      { remoteModelCatalog },
    );
    expect(createSdkClient.mock.calls[0][0].clientTools).toBe(clientTools);
    expect(clientTools.map((tool) => tool.schema.name)).toEqual([
      "send_photo_to_telegram",
      "send_video_to_telegram",
      "send_audio_to_telegram",
      "send_document_to_telegram",
    ]);
  });
});
