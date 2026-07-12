import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { Skill } from "../types.js";
import { parseMarkdownFrontMatter } from "./markdown_frontmatter.js";

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
  .strip();

export function parseSkill(filePath: string, content: string): { skill?: Skill; error?: string } {
  const markdownResult = parseMarkdownFrontMatter(content);
  if (!markdownResult.ok) {
    return {
      error: `${filePath}: ${markdownResult.message}. skipped.`,
    };
  }

  const parsedFrontMatter = skillFrontMatterSchema.safeParse(markdownResult.frontMatter);
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
