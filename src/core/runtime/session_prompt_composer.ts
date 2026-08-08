import { formatSubagentsForPrompt, getSubagentBasePrompt } from "../subagents/registry.js";
import type { Persona } from "../types.js";
import { buildBaseSystemPrompt, buildEnvironmentTag } from "../utils/context.js";
export type ComposeSessionPromptsArgs = {
  persona: Persona;
  sessionId?: string;
  cwd: string;
  repoRoot?: string;
  repository?: string;
  sessionStartedAt: string;
  platform: NodeJS.Platform;
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
    sessionId: args.sessionId,
    cwd: args.cwd,
    repoRoot: args.repoRoot,
    repository: args.repository,
    sessionStartedAt: args.sessionStartedAt,
    platform: args.platform,
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
        sessionId: args.sessionId,
        cwd: args.cwd,
        repoRoot: args.repoRoot,
        repository: args.repository,
        sessionStartedAt: args.sessionStartedAt,
        platform: args.platform,
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
