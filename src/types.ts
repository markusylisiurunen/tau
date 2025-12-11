import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";

export interface Persona {
  id: string;
  label: string;
  description?: string;
  model: Model<Api>;
  systemPrompt: string;
  settings: SimpleStreamOptions;
}
