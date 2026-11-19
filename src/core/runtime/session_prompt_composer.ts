import { type AgentCapabilities, formatCapabilitiesForPrompt } from "../agent/capabilities.js";
import { formatSubagentsForPrompt } from "../subagents/registry.js";
import type { Persona } from "../types.js";
import { buildBaseSystemPrompt, buildEnvironmentTag } from "../utils/context.js";
import { formatModelPromptNotes } from "./model_prompt_notes.js";

type PromptSourceArgs = {
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

export type ComposeSessionPromptsArgs = PromptSourceArgs & {
  /** The capabilities of the agent the base prompt is for. Workers describe their own. */
  capabilities: AgentCapabilities;
};

export type SessionPromptComposition = {
  environmentTag: string;
  baseSystemPrompt: string;
  subagentSystemPrompt: string;
};

function promptContext(args: PromptSourceArgs) {
  const environmentTag = buildEnvironmentTag({
    sessionId: args.sessionId,
    cwd: args.cwd,
    repoRoot: args.repoRoot,
    repository: args.repository,
    sessionStartedAt: args.sessionStartedAt,
    platform: args.platform,
  });

  return {
    personaSystemPrompt: args.persona.systemPrompt,
    skillsBlock: args.skillsBlock,
    projectContextBlock: args.projectContextBlock,
    environmentTag,
  };
}

/** The shared prompt a native worker builds on, without the main agent's own sections. */
export function composeSubagentSystemPrompt(args: PromptSourceArgs): string {
  return buildBaseSystemPrompt(promptContext(args));
}

export function composeSessionPrompts(args: ComposeSessionPromptsArgs): SessionPromptComposition {
  const context = promptContext(args);
  const baseSystemPrompt = buildBaseSystemPrompt({
    ...context,
    subagentsBlock: args.capabilities.delegation.available
      ? formatSubagentsForPrompt(args.persona)
      : undefined,
    capabilitiesBlock: formatCapabilitiesForPrompt(args.capabilities),
    modelNotes: formatModelPromptNotes(args.persona.model),
  });

  return {
    environmentTag: context.environmentTag,
    baseSystemPrompt,
    // A subagent may run on another model, so it adds the notes for its own model itself.
    subagentSystemPrompt: buildBaseSystemPrompt(context),
  };
}
