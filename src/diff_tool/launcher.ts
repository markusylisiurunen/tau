import type { DiffToolConfig } from "../core/config/index.js";
import { DEFAULT_DIFF_TOOL_CODE_THEME } from "./shared_types.js";

export type CreateBuiltInDiffToolConfigOptions = {
  nodeExecutablePath: string;
  cliEntryPath: string;
  codeTheme?: string;
};

export function createBuiltInDiffToolConfig(
  options: CreateBuiltInDiffToolConfigOptions,
): DiffToolConfig {
  return {
    command: options.nodeExecutablePath,
    args: [options.cliEntryPath, "diff-tool"],
    env: { TAU_DIFF_CODE_THEME: options.codeTheme ?? DEFAULT_DIFF_TOOL_CODE_THEME },
  };
}
