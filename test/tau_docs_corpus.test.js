import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsDir = resolve("docs/tau");
const manifest = JSON.parse(readFileSync(join(docsDir, "manifest.json"), "utf8"));
const files = manifest.files;
const markdownLinkPattern = /\[[^\]]+\]\(([^)]+\.md)\)/g;
const maxDocumentBytes = 24 * 1024;

function linksIn(content) {
  return [...content.matchAll(markdownLinkPattern)].map((match) => match[1]);
}

describe("Tau documentation corpus", () => {
  it("has a complete flat manifest", () => {
    expect(files[0]).toBe("index.md");
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(file).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
      expect(statSync(join(docsDir, file)).isFile()).toBe(true);
    }

    const sourceFiles = readdirSync(docsDir, { recursive: true })
      .filter((file) => file.endsWith(".md"))
      .sort();
    expect(sourceFiles).toEqual([...files].sort());
  });

  it("indexes every document exactly once", () => {
    const index = readFileSync(join(docsDir, "index.md"), "utf8");
    for (const file of files.slice(1)) {
      const matches = linksIn(index).filter((link) => link === file);
      expect(matches, file).toHaveLength(1);
    }
  });

  it("uses valid flat internal links and bounded documents", () => {
    const known = new Set(files);
    for (const file of files) {
      const path = join(docsDir, file);
      const content = readFileSync(path, "utf8");
      expect(statSync(path).size, file).toBeLessThanOrEqual(maxDocumentBytes);
      for (const link of linksIn(content)) {
        expect(link, `${file} -> ${link}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
        expect(known.has(link), `${file} -> ${link}`).toBe(true);
      }
    }
  });
});
