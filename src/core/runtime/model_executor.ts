import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import type { TauStreamOptions } from "../utils/streaming_settings.js";

export type ModelExecutor = {
  model: Model<Api>;
  stream(context: Context, options: TauStreamOptions): AssistantMessageEventStream;
  noteProviderError(options: { sessionId: string; error?: unknown }): Promise<void>;
  cleanupSession(sessionId: string): void;
};
