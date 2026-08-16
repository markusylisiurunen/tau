import type { RemoteModelCatalogSnapshot } from "../core/models/remote_catalog.js";
import { composeSessionPrompts } from "../core/runtime/session_prompt_composer.js";
import type { ResolveSubagentPrompts } from "../core/tools/spawn_agent.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";

export function createExecutionEnvironmentSubagentPromptResolver(options: {
  sessionId: string;
  executionEnvironment: ExecutionEnvironment;
  getRemoteModelCatalog: () => RemoteModelCatalogSnapshot;
  includeAgentContext: boolean;
  sessionStartedAt: number;
}): ResolveSubagentPrompts {
  return async ({ cwd, persona }) => {
    const { config, skills } = await options.executionEnvironment.resolveRuntimeConfig(cwd, {
      remoteCatalog: options.getRemoteModelCatalog(),
    });
    const runtimeContext = await options.executionEnvironment.resolveRuntimeContext({
      cwd,
      persona,
      discoveredSkills: skills,
      includeAgentContext: options.includeAgentContext,
      agentContextFiles: config.agentContextFiles ?? [],
    });
    const promptContext = runtimeContext.promptBootstrap.promptContext;
    return composeSessionPrompts({
      persona,
      sessionId: options.sessionId,
      cwd: promptContext.cwd,
      repoRoot: promptContext.repoRoot,
      repository: promptContext.repository,
      sessionStartedAt: new Date(options.sessionStartedAt).toISOString(),
      platform: promptContext.platform,
      skillsBlock: promptContext.skillsBlock,
      projectContextBlock: promptContext.projectContextBlock,
    }).subagentPrompts;
  };
}
