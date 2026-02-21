import { parse as parseYaml } from "yaml";

export type MarkdownFrontMatter = Record<string, unknown>;

export type ParseMarkdownFrontMatterResult =
  | { ok: true; hasFrontMatter: boolean; frontMatter: MarkdownFrontMatter; body: string }
  | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseMarkdownFrontMatter(content: string): ParseMarkdownFrontMatterResult {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { ok: true, hasFrontMatter: false, frontMatter: {}, body: content };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return { ok: false, message: "frontmatter is missing a closing '---' delimiter" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, endIndex).join("\n")) as unknown;
  } catch (error) {
    return {
      ok: false,
      message: `invalid frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed)) return { ok: false, message: "frontmatter must be a YAML object" };

  return {
    ok: true,
    hasFrontMatter: true,
    frontMatter: parsed as MarkdownFrontMatter,
    body: lines
      .slice(endIndex + 1)
      .join("\n")
      .trim(),
  };
}
