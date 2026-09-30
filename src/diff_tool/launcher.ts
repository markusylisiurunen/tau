import type { DiffToolConfig } from "../core/config/index.js";

export type CreateBuiltInDiffToolConfigOptions = {
  nodeExecutablePath: string;
  cliEntryPath: string;
};

export function createBuiltInDiffToolConfig(
  options: CreateBuiltInDiffToolConfigOptions,
): DiffToolConfig {
  return {
    command: options.nodeExecutablePath,
    args: [options.cliEntryPath, "diff-tool"],
  };
}
