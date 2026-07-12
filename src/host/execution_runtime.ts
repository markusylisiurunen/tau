import { composeSessionPrompts } from "../core/runtime/session_prompt_composer.js";
import type { ResolveSubagentRuntime } from "../core/tools/registry.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";

export function createExecutionEnvironmentSubagentRuntimeResolver(options: {
  executionEnvironment: ExecutionEnvironment;
  includeAgentContext: boolean;
  now: () => number;
}): ResolveSubagentRuntime {
  return async ({ cwd, persona }) => {
    const runtimeConfig = await options.executionEnvironment.resolveRuntimeConfig(cwd);
    const targetPersona = runtimeConfig.personas.find(
      (candidate) => candidate.id.toLowerCase() === persona.id.toLowerCase(),
    );
    if (!targetPersona) {
      throw new Error(`persona '${persona.id}' is not available for working directory '${cwd}'`);
    }
    const runtimeContext = await options.executionEnvironment.resolveRuntimeContext({
      cwd,
      persona: targetPersona,
      discoveredSkills: runtimeConfig.skills,
      includeAgentContext: options.includeAgentContext,
      agentContextFiles: runtimeConfig.config.agentContextFiles ?? [],
    });
    const promptContext = runtimeContext.promptBootstrap.promptContext;
    const composition = composeSessionPrompts({
      persona: targetPersona,
      cwd: promptContext.cwd,
      repoRoot: promptContext.repoRoot,
      datetime: new Date(options.now()).toISOString(),
      platform: promptContext.platform,
      nodeVersion: promptContext.nodeVersion,
      skillsBlock: promptContext.skillsBlock,
      projectContextBlock: promptContext.projectContextBlock,
    });
    return {
      persona: targetPersona,
      config: runtimeConfig.config,
      modelResolver: runtimeConfig.bootstrap.modelResolver.resolveModel,
      subagentPrompts: composition.subagentPrompts,
    };
  };
}
