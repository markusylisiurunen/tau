import {
  getFiletypeFromFileName,
  preloadHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { useEffect, useState } from "react";
import type { DiffFile } from "./parse_diff.js";

export const DIFF_CODE_THEME = "github-dark-dimmed";

export function useDiffRendererReady(files: DiffFile[]): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (files.length === 0) {
      setReady(false);
      return;
    }

    let active = true;
    setReady(false);

    void prepareDiffRenderer(files).then(() => {
      if (active) {
        setReady(true);
      }
    });

    return () => {
      active = false;
    };
  }, [files]);

  return ready;
}

async function prepareDiffRenderer(files: DiffFile[]): Promise<void> {
  await Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    preloadHighlighter({
      themes: [DIFF_CODE_THEME],
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
