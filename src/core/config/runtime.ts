import type { PromptTemplate } from "../prompts.js";
import type { Persona, Skill } from "../types.js";
import type { BashCommand } from "./bash_commands.js";
import { loadBashCommands } from "./bash_commands.js";
import { loadAllContent } from "./content_loader.js";
import type { Config } from "./schema.js";
import { loadConfig } from "./schema.js";

export interface RuntimeConfigResult {
  config: Config;
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  bashCommands: BashCommand[];
  warnings: string[];
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigResult> {
  const config = loadConfig(cwd);
  const content = await loadAllContent(config, { cwd });
  const bash = loadBashCommands(cwd);
  const warnings = [...content.errors, ...bash.errors];

  return {
    config,
    personas: content.personas,
    prompts: content.prompts,
    skills: content.skills,
    bashCommands: bash.commands,
    warnings,
  };
}
