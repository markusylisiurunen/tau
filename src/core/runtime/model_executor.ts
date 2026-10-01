import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import type { TauStreamOptions } from "../utils/streaming_settings.js";

export type ModelExecutor = {
  model: Model<Api>;
  stream(context: Context, options: TauStreamOptions): AssistantMessageEventStream;
  cleanupSession(sessionId: string): void;
};
