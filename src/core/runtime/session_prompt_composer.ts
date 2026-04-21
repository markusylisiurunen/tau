import { formatSubagentsForPrompt, getSubagentBasePrompt } from "../subagents/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import { buildBaseSystemPrompt, buildEnvironmentTag } from "../utils/context.js";
import { resolvePromptGitRoot } from "../utils/git.js";

export type ComposeSessionPromptsArgs = {
  persona: Persona;
  riskLevel: RiskLevel;
  cwd: string;
  datetime: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  skillsBlock?: string;
  projectContextBlock?: string;
};

export type SessionPromptComposition = {
  environmentTag: string;
  baseSystemPrompt: string;
  subagentPrompts: Record<string, string>;
};

export function composeSessionPrompts(args: ComposeSessionPromptsArgs): SessionPromptComposition {
  const repoRoot = resolvePromptGitRoot({ cwd: args.cwd });

  const environmentTag = buildEnvironmentTag({
    riskLevel: args.riskLevel,
    cwd: args.cwd,
    repoRoot,
    datetime: args.datetime,
    platform: args.platform,
    nodeVersion: args.nodeVersion,
  });

  const baseSystemPrompt = buildBaseSystemPrompt({
    personaSystemPrompt: args.persona.systemPrompt,
    skillsBlock: args.skillsBlock,
    projectContextBlock: args.projectContextBlock,
    environmentTag,
    subagentsBlock: formatSubagentsForPrompt(args.persona),
  });

  const subagentPrompts: Record<string, string> = {};
  const subagents = args.persona.subagents;
  if (subagents) {
    for (const [name, config] of Object.entries(subagents)) {
      const personaSystemPrompt = getSubagentBasePrompt({
        name,
        config,
        mainPersonaSystemPrompt: args.persona.systemPrompt,
      });

      const subagentEnvironmentTag = buildEnvironmentTag({
        riskLevel: config.riskLevel ?? args.riskLevel,
        cwd: args.cwd,
        repoRoot,
        datetime: args.datetime,
        platform: args.platform,
        nodeVersion: args.nodeVersion,
      });

      subagentPrompts[name] = buildBaseSystemPrompt({
        personaSystemPrompt,
        skillsBlock: args.skillsBlock,
        projectContextBlock: args.projectContextBlock,
        environmentTag: subagentEnvironmentTag,
      });
    }
  }

  return {
    environmentTag,
    baseSystemPrompt,
    subagentPrompts,
  };
}
