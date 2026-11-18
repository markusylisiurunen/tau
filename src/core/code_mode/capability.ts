import type { TauCodeModeApi } from "../../code_mode/runtime.js";

export type CodeModeCapability = {
  name: string;
  description: string;
  api: TauCodeModeApi;
};
