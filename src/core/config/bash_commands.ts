import { z } from "zod";

export interface BashCommand {
  id: string;
  description?: string;
  cmd: string;
}

const bashCommandSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().optional(),
    cmd: z.string().trim().min(1),
  })
  .passthrough();

export function parseBashCommands(raw: unknown, sourceLabel: string): {
  commands: BashCommand[];
  errors: string[];
} {
  const errors: string[] = [];

  if (raw === undefined) {
    return { commands: [], errors };
  }

  if (!Array.isArray(raw)) {
    errors.push(`${sourceLabel}: 'bashCommands' must be an array.`);
    return { commands: [], errors };
  }

  const commands: BashCommand[] = [];

  for (const entryRaw of raw) {
    if (typeof entryRaw !== "object" || entryRaw === null) {
      errors.push(`${sourceLabel}: bashCommands entries must be objects.`);
      continue;
    }

    const idRaw = (entryRaw as { id?: unknown }).id;
    const idForMessage = typeof idRaw === "string" ? idRaw.trim() : "";

    const entry = bashCommandSchema.safeParse(entryRaw);
    if (!entry.success) {
      if (!idForMessage) {
        errors.push(`${sourceLabel}: bashCommands entry missing valid 'id'.`);
        continue;
      }

      const hasCmdIssue = entry.error.issues.some((issue) => issue.path[0] === "cmd");
      if (hasCmdIssue) {
        errors.push(`${sourceLabel}: bashCommands entry '${idForMessage}' missing valid 'cmd'.`);
        continue;
      }

      errors.push(`${sourceLabel}: bashCommands entry '${idForMessage}' is invalid.`);
      continue;
    }

    commands.push(entry.data);
  }

  return { commands, errors };
}
