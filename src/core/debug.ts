import type { Tool } from "@mariozechner/pi-ai";
import type { BashCommand, VirtualBundle } from "./config/index.js";
import type { PromptTemplate } from "./prompts.js";
import { createDefaultCoreDeps } from "./runtime/deps.js";
import {
  formatSubagentsForPrompt,
  resolveSubagentEffectiveSettings,
} from "./subagents/registry.js";
import type { SubagentPersonaConfig } from "./subagents/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { Persona, RiskLevel, Skill } from "./types.js";
import {
  buildBaseSystemPrompt,
  buildEnvironmentTag,
  buildProjectContextBlock,
  buildSkillsIndexBlock,
} from "./utils/context.js";
import { resolvePromptGitRoot } from "./utils/git.js";

function section(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function formatPersona(p: Persona): string {
  const lines = [
    `  id: ${p.id}`,
    `  label: ${p.label}`,
    `  model: ${p.model.provider}:${p.model.id}`,
  ];
  if (p.description) lines.push(`  description: ${p.description}`);
  if (p.settings.reasoning) lines.push(`  reasoning: ${p.settings.reasoning}`);
  if (p.settings.serviceTier) lines.push(`  serviceTier: ${p.settings.serviceTier}`);
  if (p.allowedReasoningLevels) {
    lines.push(`  allowedReasoningLevels: ${p.allowedReasoningLevels.join(", ")}`);
  }
  if (p.skills) {
    lines.push(`  skills: ${p.skills === "*" ? "*" : p.skills.join(", ")}`);
  }
  if (p.subagents) {
    const names = Object.keys(p.subagents).join(", ");
    lines.push(`  subagents: ${names}`);
  }
  if (p.tools && p.tools.length > 0) {
    lines.push(`  tools: ${p.tools.map((t) => t.name).join(", ")}`);
  }
  return lines.join("\n");
}

function formatPrompt(p: PromptTemplate): string {
  const lines = [`  id: ${p.id}`];
  if (p.label) lines.push(`  label: ${p.label}`);
  if (p.description) lines.push(`  description: ${p.description}`);
  lines.push(`  template: ${p.template.length} chars`);
  return lines.join("\n");
}

function formatBashCommand(cmd: BashCommand): string {
  const lines = [`  id: ${cmd.id}`, `  cmd: ${cmd.cmd}`];
  if (cmd.description) lines.push(`  description: ${cmd.description}`);
  if (cmd.cwd) lines.push(`  cwd: ${cmd.cwd}`);
  return lines.join("\n");
}

function formatSkill(s: Skill): string {
  return [`  name: ${s.name}`, `  description: ${s.description}`, `  path: ${s.path}`].join("\n");
}

function formatToolSchema(tool: Tool): string {
  const lines = [`  name: ${tool.name}`];
  lines.push(`  description: ${tool.description}`);
  lines.push(
    `  parameters: ${JSON.stringify(tool.parameters, null, 4).split("\n").join("\n    ")}`,
  );
  return lines.join("\n");
}

function getActiveSkills(persona: Persona | undefined, skills: Skill[]): Skill[] {
  if (!persona?.skills) return [];
  if (persona.skills === "*") return skills;
  const enabledNames = new Set(persona.skills.map((s) => s.toLowerCase()));
  return skills.filter((s) => enabledNames.has(s.name.toLowerCase()));
}

export function printDebugInfo(args: {
  personas: Persona[];
  prompts: PromptTemplate[];
  bashCommands: BashCommand[];
  skills: Skill[];
  selectedPersona?: Persona;
  noAgentContextFiles: boolean;
  riskLevel?: RiskLevel;
  toolRegistry: ToolRegistry;
  virtualBundle?: VirtualBundle;
}): void {
  const {
    personas,
    prompts,
    bashCommands,
    skills,
    selectedPersona,
    noAgentContextFiles,
    riskLevel,
    toolRegistry,
    virtualBundle,
  } = args;

  const deps = createDefaultCoreDeps();
  const cwd = deps.env.cwd();
  const home = deps.env.home();

  console.log("tau debug info");
  console.log(`cwd: ${cwd}`);

  section("virtual bundle");
  if (!virtualBundle) {
    console.log("\n  (not available)");
  } else {
    const defaultPersona = virtualBundle.config.defaultPersona ?? "(none)";
    const defaultRisk = virtualBundle.config.defaultRisk ?? "(none)";
    const personaIds = virtualBundle.personas.map((p) => p.id).join(", ") || "(none)";
    const promptIds = virtualBundle.prompts.map((p) => p.id).join(", ") || "(none)";
    console.log(`\n  defaultPersona: ${defaultPersona}`);
    console.log(`  defaultRisk: ${defaultRisk}`);
    console.log(`  personas: ${personaIds}`);
    console.log(`  prompts: ${promptIds}`);
  }

  // Personas
  section(`personas (${personas.length})`);
  if (personas.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const p of personas) {
      const selected = selectedPersona && p.id === selectedPersona.id ? " [SELECTED]" : "";
      console.log(`\n- ${p.id}${selected}`);
      console.log(formatPersona(p));
    }
  }

  // Prompts
  section(`prompts (${prompts.length})`);
  if (prompts.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const p of prompts) {
      console.log(`\n- ${p.id}`);
      console.log(formatPrompt(p));
    }
  }

  // Bash commands
  section(`bash commands (${bashCommands.length})`);
  if (bashCommands.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const cmd of bashCommands) {
      console.log(`\n- ${cmd.id}`);
      console.log(formatBashCommand(cmd));
    }
  }

  // Skills
  section(`skills (${skills.length})`);
  if (skills.length === 0) {
    console.log("\n  (none)");
  } else {
    const activeSkills = getActiveSkills(selectedPersona, skills);
    const activeNames = new Set(activeSkills.map((s) => s.name));
    for (const s of skills) {
      const isActive = selectedPersona ? activeNames.has(s.name) : false;
      console.log(`\n- ${s.name}${isActive ? " [active]" : ""}`);
      console.log(formatSkill(s));
    }
  }

  // Selected persona details
  section(`selected persona: ${selectedPersona?.id ?? "(none)"}`);
  if (selectedPersona) {
    console.log(formatPersona(selectedPersona));
  } else {
    console.log("\n  (no persona loaded)");
  }

  // Build and print full system prompt
  section("full system prompt");

  if (!selectedPersona) {
    console.log("\n  (skipped: no persona loaded)");
    return;
  }

  const activeSkills = getActiveSkills(selectedPersona, skills);
  const skillsBlock = buildSkillsIndexBlock(activeSkills);
  const projectContextBlock = !noAgentContextFiles
    ? buildProjectContextBlock({ cwd, home, readFile: deps.fs.readFile })
    : undefined;
  const effectiveRiskLevel: RiskLevel = riskLevel ?? "read-only";
  const repoRoot = resolvePromptGitRoot({ cwd });
  const environmentTag = buildEnvironmentTag({
    riskLevel: effectiveRiskLevel,
    cwd,
    repoRoot,
    datetime: new Date(deps.clock.now()).toISOString(),
    platform: deps.env.platform(),
    nodeVersion: deps.env.nodeVersion(),
  });
  const subagentsBlock = formatSubagentsForPrompt(selectedPersona);
  const fullSystemPrompt = buildBaseSystemPrompt({
    personaSystemPrompt: selectedPersona.systemPrompt,
    skillsBlock,
    projectContextBlock,
    environmentTag,
    subagentsBlock,
  });

  console.log(`\n${fullSystemPrompt}`);

  // Sub-agents
  const activeSubagents = selectedPersona.subagents
    ? Object.entries(selectedPersona.subagents)
    : [];
  const enabledSubagents = activeSubagents.filter(
    (entry): entry is [string, SubagentPersonaConfig] => Boolean(entry[1]),
  );
  section(`active sub-agents (${enabledSubagents.length})`);
  if (enabledSubagents.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const [name, cfg] of enabledSubagents) {
      console.log(`\n- ${name}`);
      const effective = resolveSubagentEffectiveSettings({
        persona: selectedPersona,
        config: cfg,
        riskLevel: effectiveRiskLevel,
      });
      console.log(`  model: ${effective.model.provider}:${effective.model.id}`);
      if (effective.settings) {
        console.log(`  settings: ${JSON.stringify(effective.settings)}`);
      }
      console.log(`  riskLevel: ${effective.riskLevel}`);
      if (effective.tools.length > 0) {
        console.log(`  tools: ${effective.tools.join(", ")}`);
      }
    }
  }

  // Tools
  const enabledTools = toolRegistry.getEnabledToolSchemas(selectedPersona.tools);

  section(`active tools (${enabledTools.length})`);
  if (enabledTools.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const tool of enabledTools) {
      console.log(`\n- ${tool.name}`);
      console.log(formatToolSchema(tool));
    }
  }
}
