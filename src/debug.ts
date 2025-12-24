import { homedir } from "node:os";
import type { Tool } from "@markusylisiurunen/iota";
import type { BashCommand } from "./bash_commands.js";
import type { PromptTemplate } from "./prompts.js";
import { formatSubagentsForPrompt } from "./subagents/registry.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { Persona, RiskLevel, Skill } from "./types.js";
import {
  buildBaseSystemPrompt,
  buildEnvironmentTag,
  buildProjectContextBlock,
  buildSkillsIndexBlock,
} from "./utils/context.js";

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

function getActiveSkills(persona: Persona, skills: Skill[]): Skill[] {
  if (!persona.skills) return [];
  if (persona.skills === "*") return skills;
  const enabledNames = new Set(persona.skills.map((s) => s.toLowerCase()));
  return skills.filter((s) => enabledNames.has(s.name.toLowerCase()));
}

export function printDebugInfo(args: {
  personas: Persona[];
  prompts: PromptTemplate[];
  bashCommands: BashCommand[];
  skills: Skill[];
  selectedPersona: Persona;
  withContext: boolean;
  riskLevel?: RiskLevel;
  toolRegistry: ToolRegistry;
}): void {
  const {
    personas,
    prompts,
    bashCommands,
    skills,
    selectedPersona,
    withContext,
    riskLevel,
    toolRegistry,
  } = args;

  console.log("tau debug info");
  console.log(`cwd: ${process.cwd()}`);

  // Personas
  section(`Personas (${personas.length})`);
  for (const p of personas) {
    console.log(`\n- ${p.id}${p.id === selectedPersona.id ? " [SELECTED]" : ""}`);
    console.log(formatPersona(p));
  }

  // Prompts
  section(`Prompts (${prompts.length})`);
  if (prompts.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const p of prompts) {
      console.log(`\n- ${p.id}`);
      console.log(formatPrompt(p));
    }
  }

  // Bash commands
  section(`Bash commands (${bashCommands.length})`);
  if (bashCommands.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const cmd of bashCommands) {
      console.log(`\n- ${cmd.id}`);
      console.log(formatBashCommand(cmd));
    }
  }

  // Skills
  section(`Skills (${skills.length})`);
  if (skills.length === 0) {
    console.log("\n  (none)");
  } else {
    const activeSkills = getActiveSkills(selectedPersona, skills);
    const activeNames = new Set(activeSkills.map((s) => s.name));
    for (const s of skills) {
      const isActive = activeNames.has(s.name);
      console.log(`\n- ${s.name}${isActive ? " [ACTIVE]" : ""}`);
      console.log(formatSkill(s));
    }
  }

  // Selected persona details
  section(`Selected persona: ${selectedPersona.id}`);
  console.log(formatPersona(selectedPersona));

  // Build and print full system prompt
  section("Full system prompt");

  const activeSkills = getActiveSkills(selectedPersona, skills);
  const skillsBlock = buildSkillsIndexBlock(activeSkills);
  const projectContextBlock = withContext
    ? buildProjectContextBlock({ cwd: process.cwd(), home: homedir() })
    : undefined;
  const effectiveRiskLevel: RiskLevel = riskLevel ?? "read-only";
  const environmentTag = buildEnvironmentTag({
    riskLevel: effectiveRiskLevel,
    cwd: process.cwd(),
    datetime: new Date().toISOString(),
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
    ? Object.entries(selectedPersona.subagents).filter(([, cfg]) => cfg)
    : [];
  section(`Active sub-agents (${activeSubagents.length})`);
  if (activeSubagents.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const [name, cfg] of activeSubagents) {
      console.log(`\n- ${name}`);
      console.log(`  model: ${cfg.model.provider}:${cfg.model.id}`);
      if (cfg.settings) {
        console.log(`  settings: ${JSON.stringify(cfg.settings)}`);
      }
    }
  }

  // Tools
  const enabledTools = toolRegistry.getEnabledToolSchemas(
    effectiveRiskLevel,
    selectedPersona.tools,
  );

  section(`Active tools (${enabledTools.length})`);
  if (enabledTools.length === 0) {
    console.log("\n  (none)");
  } else {
    for (const tool of enabledTools) {
      console.log(`\n- ${tool.name}`);
      console.log(formatToolSchema(tool));
    }
  }
}
