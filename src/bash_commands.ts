import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getGitRoot } from "./utils/git.js";

export interface BashCommand {
  id: string;
  description?: string;
  cmd: string;
}

function parseBashCommandsFromJson(
  raw: unknown,
  sourceLabel: string,
): {
  commands: BashCommand[];
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { commands: [], errors };
  }

  const bash = (raw as { bash?: unknown }).bash;
  if (bash === undefined) {
    return { commands: [], errors };
  }

  if (!Array.isArray(bash)) {
    errors.push(`${sourceLabel}: 'bash' must be an array.`);
    return { commands: [], errors };
  }

  const commands: BashCommand[] = [];

  for (const entry of bash) {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${sourceLabel}: bash entries must be objects.`);
      continue;
    }

    const { id, description, cmd } = entry as {
      id?: unknown;
      description?: unknown;
      cmd?: unknown;
    };

    if (typeof id !== "string" || !id.trim()) {
      errors.push(`${sourceLabel}: bash entry missing valid 'id'.`);
      continue;
    }

    if (typeof cmd !== "string" || !cmd.trim()) {
      errors.push(`${sourceLabel}: bash entry '${id}' missing valid 'cmd'.`);
      continue;
    }

    commands.push({
      id: id.trim(),
      description:
        typeof description === "string" && description.trim() ? description.trim() : undefined,
      cmd: cmd.trim(),
    });
  }

  return { commands, errors };
}

function loadBashCommandsFile(
  path: string,
  sourceLabel: string,
): {
  commands: BashCommand[];
  errors: string[];
} {
  try {
    if (!existsSync(path)) {
      return { commands: [], errors: [] };
    }

    const content = readFileSync(path, "utf-8");
    const json = JSON.parse(content) as unknown;

    return parseBashCommandsFromJson(json, sourceLabel);
  } catch (err) {
    return {
      commands: [],
      errors: [
        `${sourceLabel}: failed to read/parse: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

export function loadBashCommands(cwd: string): {
  commands: BashCommand[];
  errors: string[];
  repoRoot?: string;
} {
  const errors: string[] = [];

  const repoRoot = getGitRoot(cwd);
  const repoConfigPath = repoRoot ? join(repoRoot, ".tau", "config.json") : undefined;
  const homeConfigPath = join(homedir(), ".tau", "config.json");

  const repoRes = repoConfigPath
    ? loadBashCommandsFile(repoConfigPath, resolve(repoConfigPath))
    : { commands: [], errors: [] };
  const homeRes = loadBashCommandsFile(homeConfigPath, resolve(homeConfigPath));

  errors.push(...repoRes.errors, ...homeRes.errors);

  const byId = new Map<string, BashCommand>();

  for (const cmd of repoRes.commands) {
    byId.set(cmd.id.toLowerCase(), cmd);
  }

  for (const cmd of homeRes.commands) {
    const key = cmd.id.toLowerCase();
    if (byId.has(key)) continue;
    byId.set(key, cmd);
  }

  return { commands: [...byId.values()], errors, repoRoot };
}
