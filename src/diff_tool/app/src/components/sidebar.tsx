import { FileDiff, MessagesSquare } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommentThread } from "../comments.js";
import type { DiffFile } from "../parse_diff.js";
import { DiffStats } from "./diff_stats.js";
import "./sidebar.css";

type SidebarProps = {
  open: boolean;
  files: DiffFile[];
  viewed: Record<string, boolean>;
  threads: CommentThread[];
  selectedThreadId: string | null;
  onJumpToFile: (fileId: string) => void;
  onCreateDetachedThread: () => void;
  onOpenThread: (thread: CommentThread) => void;
};

type SidebarFileGroup = {
  directory: string;
  files: DiffFile[];
};

export function Sidebar({
  open,
  files,
  viewed,
  threads,
  selectedThreadId,
  onJumpToFile,
  onCreateDetachedThread,
  onOpenThread,
}: SidebarProps) {
  const fileGroups = groupSidebarFiles(files);

  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <h2 className="sidebar-section-title">conversations</h2>
          <button
            type="button"
            className="btn sidebar-action"
            onClick={onCreateDetachedThread}
          >
            new thread
          </button>
        </div>
        <div className="sidebar-conversations">
          {threads.length === 0 ? (
            <p className="sidebar-empty">no conversations yet</p>
          ) : (
            threads.map((thread) => {
              const name = getThreadName(thread);
              const status = thread.loading ? "active" : "idle";
              const ThreadIcon =
                thread.anchor.kind === "line" ? FileDiff : MessagesSquare;
              const threadKind =
                thread.anchor.kind === "line" ? "diff comment" : "thread";

              return (
                <button
                  key={thread.id}
                  type="button"
                  className={`sidebar-thread-item${
                    selectedThreadId === thread.id ? " selected" : ""
                  }${thread.resolved ? " resolved" : ""}`}
                  onClick={() => onOpenThread(thread)}
                  title={name}
                >
                  <span className="sidebar-thread-row">
                    <ThreadIcon
                      className="sidebar-thread-kind"
                      size={13}
                      aria-label={threadKind}
                    />
                    <span className="sidebar-thread-name">{name}</span>
                    <span
                      className={`sidebar-thread-status-dot ${status}`}
                      aria-label={status}
                      title={status}
                    />
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
      <div className="sidebar-divider" />
      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <h2 className="sidebar-section-title">files</h2>
        </div>
        <div className="sidebar-file-list">
          {fileGroups.map((group, index) => (
            <div
              key={`${group.directory}:${index}`}
              className="sidebar-file-group"
            >
              <SidebarDirectoryLabel directory={group.directory} />
              {group.files.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  className={`sidebar-item${viewed[file.id] ? " viewed" : ""}`}
                  onClick={() => onJumpToFile(file.id)}
                  title={file.displayPath}
                >
                  <span className="sidebar-row">
                    <span
                      className={`sidebar-file-status ${file.status}`}
                      aria-label={file.status}
                    >
                      {formatFileStatus(file.status)}
                    </span>
                    <span className="sidebar-file-name">
                      {formatFileName(file)}
                    </span>
                    <DiffStats
                      additions={file.additions}
                      deletions={file.deletions}
                      className="sidebar-stats"
                    />
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

type SidebarDirectoryLabelProps = {
  directory: string;
};

function SidebarDirectoryLabel({ directory }: SidebarDirectoryLabelProps) {
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

function groupSidebarFiles(files: DiffFile[]): SidebarFileGroup[] {
  const groups: SidebarFileGroup[] = [];

  for (const file of files) {
    const directory = formatDirectoryName(file.newRepoPath);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.directory === directory) {
      lastGroup.files.push(file);
      continue;
    }

    groups.push({ directory, files: [file] });
  }

  return groups;
}

function formatDirectoryName(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) {
    return "./";
  }

  return `${path.slice(0, index)}/`;
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

function formatFileName(file: DiffFile): string {
  return basename(file.newRepoPath);
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function formatFileStatus(status: DiffFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "type-changed":
      return "T";
    case "unmerged":
      return "U";
    case "modified":
      return "M";
    case "unknown":
      return "?";
  }
}

function getThreadName(thread: CommentThread): string {
  const firstUserMessage = thread.messages.find(
    (message) => message.role === "user",
  );
  const normalized = collapseWhitespace(firstUserMessage?.text ?? "");
  if (!normalized) {
    return "new conversation";
  }

  return normalized.length <= 128
    ? normalized
    : `${normalized.slice(0, 125).trimEnd()}…`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
