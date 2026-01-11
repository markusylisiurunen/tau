import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { getGitRoot } from "./utils/git.js";

export interface BashCommand {
  id: string;
  description?: string;
  cmd: string;
}

const bashCommandsFileSchema = z
  .object({
    bash: z.array(z.unknown()).optional(),
  })
  .passthrough();

const bashCommandSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().optional(),
    cmd: z.string().trim().min(1),
  })
  .passthrough();

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

  const root = bashCommandsFileSchema.safeParse(raw);
  if (!root.success) {
    errors.push(`${sourceLabel}: 'bash' must be an array.`);
    return { commands: [], errors };
  }

  if (root.data.bash === undefined) {
    return { commands: [], errors };
  }

  const bash = root.data.bash;

  if (!Array.isArray(bash)) {
    errors.push(`${sourceLabel}: 'bash' must be an array.`);
    return { commands: [], errors };
  }

  const commands: BashCommand[] = [];

  for (const entryRaw of bash) {
    if (typeof entryRaw !== "object" || entryRaw === null) {
      errors.push(`${sourceLabel}: bash entries must be objects.`);
      continue;
    }

    const idRaw = (entryRaw as { id?: unknown }).id;
    const idForMessage = typeof idRaw === "string" ? idRaw.trim() : "";

    const entry = bashCommandSchema.safeParse(entryRaw);
    if (!entry.success) {
      if (!idForMessage) {
        errors.push(`${sourceLabel}: bash entry missing valid 'id'.`);
        continue;
      }

      const hasCmdIssue = entry.error.issues.some((issue) => issue.path[0] === "cmd");
      if (hasCmdIssue) {
        errors.push(`${sourceLabel}: bash entry '${idForMessage}' missing valid 'cmd'.`);
        continue;
      }

      errors.push(`${sourceLabel}: bash entry '${idForMessage}' is invalid.`);
      continue;
    }

    commands.push(entry.data);
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
  const repoConfigPath = repoRoot ? join(repoRoot, ".tau-bedrock", "config.json") : undefined;
  const homeConfigPath = join(homedir(), ".tau-bedrock", "config.json");

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
