import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { RiskLevel, Skill } from "../types.js";

function buildUserPreferencesBlock(userPreferences?: string): string | undefined {
  if (typeof userPreferences === "string" && userPreferences.trim()) {
    return ["<user_preferences>", userPreferences, "</user_preferences>"].join("\n");
  }
  return undefined;
}

export function buildSkillsIndexBlock(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;

  const lines: string[] = ["### Skills", ""];

  for (const skill of skills) {
    lines.push(`- name: ${skill.name}`);
    lines.push(`  description: ${skill.description}`);
    lines.push(`  path: ${skill.path}`);
  }

  const out = lines.join("\n").trim();
  return out ? out : undefined;
}

export function buildBaseSystemPrompt(args: {
  personaSystemPrompt: string;
  skillsBlock?: string;
  projectContextBlock?: string;
  environmentTag: string;
  previousSessionSummary?: string;
  userPreferences?: string;
}): string {
  const parts: string[] = [args.personaSystemPrompt.trim()];
  if (args.skillsBlock?.trim()) {
    parts.push(args.skillsBlock.trim());
  }
  if (args.projectContextBlock?.trim()) {
    parts.push(args.projectContextBlock.trim());
  }
  if (args.previousSessionSummary?.trim()) {
    parts.push(
      [
        "### Previous session context",
        "",
        "The following is a summary of a previous conversation session that provides relevant context:",
        "<previous_session_summary>",
        args.previousSessionSummary.trim(),
        "</previous_session_summary>",
      ].join("\n"),
    );
  }
  parts.push(args.environmentTag.trim());
  const userPrefsBlock = buildUserPreferencesBlock(args.userPreferences);
  if (userPrefsBlock) {
    parts.push(userPrefsBlock);
  }
  return parts.join("\n\n");
}

export function buildProjectContextBlock(args: { cwd: string; home: string }): string | undefined {
  const agentsFiles = findAgentsFilesFromCwdToHome(args.cwd, args.home);
  if (agentsFiles.length === 0) return undefined;

  const lines: string[] = ["### Project context", ""];

  for (const filePath of agentsFiles) {
    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    lines.push(`<file path="${filePath}">`);
    lines.push(content.trimEnd());
    lines.push("</file>");
    lines.push("");
  }

  const out = lines.join("\n").trimEnd();
  return out.trim() ? out : undefined;
}

export function findAgentsFilesFromCwdToHome(cwd: string, home: string): string[] {
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(home);

  // If we're not inside the user's home directory, don't walk beyond it.
  if (cwdAbs !== homeAbs && !cwdAbs.startsWith(homeAbs + sep)) {
    return [];
  }

  const found: string[] = [];

  let dir = cwdAbs;
  // Closest-first order: cwd, parent, ..., home.
  while (true) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) {
      found.push(candidate);
    }

    if (dir === homeAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    // Stay within home.
    if (parent !== homeAbs && !parent.startsWith(homeAbs + sep)) break;

    dir = parent;
  }

  return found;
}

export function describeRiskLevel(level: RiskLevel): string {
  switch (level) {
    case "none":
      return "No bash tool access for the model.";
    case "read-only":
      return "Model may call bash only for read-only commands (safetyLevel='read').";
    case "read-write":
      return "Model may call bash for read or write commands (safetyLevel='read' or 'write').";
  }
}

export function buildEnvironmentTag(args: {
  datetime: string;
  cwd: string;
  riskLevel: RiskLevel;
}): string {
  const riskDesc = describeRiskLevel(args.riskLevel);
  const nodeVersion = process.version;
  const platform = process.platform;
  return [
    "<environment>",
    `  <datetime>${args.datetime}</datetime>`,
    `  <cwd>${args.cwd}</cwd>`,
    `  <risk_level level="${args.riskLevel}">${riskDesc}</risk_level>`,
    `  <node>${nodeVersion}</node>`,
    `  <platform>${platform}</platform>`,
    "  <notes>This environment tag is static for the session and reflects the initial risk level. If the user changes risk level, you will be informed in a <system> tag at the start of the next user message.</notes>",
    "</environment>",
  ].join("\n");
}

export function formatRiskLevelChangeNotice(change: { from: RiskLevel; to: RiskLevel }): string {
  const toDesc = describeRiskLevel(change.to);
  return `<system>Risk level changed by user from '${change.from}' to '${change.to}'. ${toDesc} This overrides the initial risk level described in the system prompt.</system>`;
}
