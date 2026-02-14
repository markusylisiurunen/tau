import { dirname, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Skill } from "../types.js";

type FrontMatter = Record<string, unknown>;

const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const skillDescriptionSchema = z.string().trim().min(1).max(1024);

const skillFrontMatterSchema = z
  .object({
    name: skillNameSchema,
    description: skillDescriptionSchema,
    license: z.string().trim().min(1).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().trim().min(1).optional(),
  })
  .passthrough();

function parseYamlFrontMatter(yamlText: string): FrontMatter {
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as FrontMatter;
  } catch {
    return {};
  }
}

function parseMarkdownWithFrontMatter(content: string): FrontMatter {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return {};
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return {};
  }

  return parseYamlFrontMatter(lines.slice(1, endIndex).join("\n"));
}

export function parseSkill(filePath: string, content: string): { skill?: Skill; error?: string } {
  const frontMatter = parseMarkdownWithFrontMatter(content);

  const parsedFrontMatter = skillFrontMatterSchema.safeParse(frontMatter);
  if (!parsedFrontMatter.success) {
    return {
      error: `${filePath}: invalid frontmatter (name/description required, and must follow the skills spec). skipped.`,
    };
  }

  const dirName = dirname(filePath).split(sep).pop();
  if (dirName && parsedFrontMatter.data.name !== dirName) {
    return {
      error: `${filePath}: frontmatter name "${parsedFrontMatter.data.name}" must match directory name "${dirName}". skipped.`,
    };
  }

  return {
    skill: {
      name: parsedFrontMatter.data.name,
      description: parsedFrontMatter.data.description,
      path: resolve(filePath),
    },
  };
}
