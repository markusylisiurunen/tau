import { useLayoutEffect, useMemo, useRef, useState } from "react";

type SidebarDirectoryLabelProps = {
  directory: string;
};

export function SidebarDirectoryLabel({
  directory,
}: SidebarDirectoryLabelProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [compactDirectory, setCompactDirectory] = useState(() =>
    initialSidebarDirectory(directory),
  );
  const measure = useMemo(() => createTextMeasurer(), []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }

    const updateCompactDirectory = () => {
      const style = window.getComputedStyle(row);
      setCompactDirectory(
        compactSidebarDirectory(
          directory,
          row.clientWidth,
          style.font,
          measure,
        ),
      );
    };

    updateCompactDirectory();

    const observer = new ResizeObserver(updateCompactDirectory);
    observer.observe(row);

    return () => {
      observer.disconnect();
    };
  }, [directory, measure]);

  return (
    <div ref={rowRef} className="sidebar-file-directory" title={directory}>
      {compactDirectory}
    </div>
  );
}

function createTextMeasurer() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  return (text: string, font: string) => {
    if (!context) {
      return text.length * 8;
    }
    context.font = font;
    return context.measureText(text).width;
  };
}

function initialSidebarDirectory(directory: string): string {
  const parts = directoryParts(directory);
  if (parts.length <= 2) {
    return directory;
  }

  return `${parts[0]}/…/${parts[parts.length - 1]}/`;
}

function compactSidebarDirectory(
  directory: string,
  maxWidth: number,
  font: string,
  measure: (text: string, font: string) => number,
): string {
  const candidates = buildDirectoryCandidates(directory);
  for (const candidate of candidates) {
    if (measure(candidate, font) <= maxWidth) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1] ?? directory;
}

function buildDirectoryCandidates(directory: string): string[] {
  const parts = directoryParts(directory);
  const candidates = [directory];

  if (parts.length > 2) {
    candidates.push(`${parts[0]}/…/${parts.slice(1).join("/")}/`);
    candidates.push(`${parts[0]}/…/${parts.slice(-2).join("/")}/`);
    candidates.push(`${parts[0]}/…/${parts[parts.length - 1]}/`);
  }

  if (parts.length > 0) {
    candidates.push(`…/${parts[parts.length - 1]}/`);
  }

  return [...new Set(candidates)];
}

function directoryParts(directory: string): string[] {
  if (directory === "./") {
    return [];
  }

  return directory.split("/").filter(Boolean);
}
