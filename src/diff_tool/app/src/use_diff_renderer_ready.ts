import {
  getFiletypeFromFileName,
  preloadHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { useEffect, useState } from "react";
import type { DiffFile } from "./parse_diff.js";
import type { CodeTheme } from "./types.js";

export function useDiffRendererReady(
  files: DiffFile[],
  codeTheme: CodeTheme,
): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (files.length === 0) {
      setReady(false);
      return;
    }

    let active = true;
    setReady(false);

    void prepareDiffRenderer(files, codeTheme).then(() => {
      if (active) {
        setReady(true);
      }
    });

    return () => {
      active = false;
    };
  }, [codeTheme, files]);

  return ready;
}

async function prepareDiffRenderer(
  files: DiffFile[],
  codeTheme: CodeTheme,
): Promise<void> {
  await Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    preloadHighlighter({
      themes: [codeTheme],
      langs: collectDiffLanguages(files),
    }).catch(() => undefined),
  ]);
}

function collectDiffLanguages(files: DiffFile[]): SupportedLanguages[] {
  const languages = new Set<SupportedLanguages>();

  for (const file of files) {
    languages.add(file.file.lang ?? getFiletypeFromFileName(file.file.name));
  }

  return [...languages];
}
