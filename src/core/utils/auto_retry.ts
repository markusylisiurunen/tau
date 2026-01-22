import type { Api, Model } from "@mariozechner/pi-ai";

export type AutoRetryContext = {
  model: Model<Api>;
  error: unknown;
};

export function shouldAutoRetry({ model: _model, error: _error }: AutoRetryContext): boolean {
  return false;
}
