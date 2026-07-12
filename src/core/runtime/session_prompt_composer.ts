import { formatSubagentsForPrompt, getSubagentBasePrompt } from "../subagents/registry.js";
import type { Persona } from "../types.js";
import { buildBaseSystemPrompt, buildEnvironmentTag } from "../utils/context.js";
export type ComposeSessionPromptsArgs = {
  persona: Persona;
  cwd: string;
  repoRoot?: string;
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
  const environmentTag = buildEnvironmentTag({
    cwd: args.cwd,
    repoRoot: args.repoRoot,
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
        cwd: args.cwd,
        repoRoot: args.repoRoot,
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
