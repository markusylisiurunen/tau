import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CommentThread } from "../comments.js";
import type { DiffFile } from "../parse_diff.js";
import type { SidebarWidth } from "../types.js";
import { DiffStats } from "./diff_stats.js";
import "./sidebar.css";

type SidebarProps = {
  open: boolean;
  widthMode: SidebarWidth;
  files: DiffFile[];
  viewed: Record<string, boolean>;
  detachedThreads: CommentThread[];
  selectedDetachedThreadId: string | null;
  onJumpToFile: (fileId: string) => void;
  onCreateDetachedThread: () => void;
  onOpenDetachedThread: (threadId: string) => void;
  onToggleWidth: () => void;
};

export function Sidebar({
  open,
  widthMode,
  files,
  viewed,
  detachedThreads,
  selectedDetachedThreadId,
  onJumpToFile,
  onCreateDetachedThread,
  onOpenDetachedThread,
  onToggleWidth,
}: SidebarProps) {
  const widthLabel =
    widthMode === "wide" ? "Use narrow sidebar" : "Use wide sidebar";

  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <button
        type="button"
        className="sidebar-width-toggle"
        aria-label={widthLabel}
        title={widthLabel}
        onClick={onToggleWidth}
      />
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
          {detachedThreads.length === 0 ? (
            <p className="sidebar-empty">no conversations yet</p>
          ) : (
            detachedThreads.map((thread) => {
              const name = getThreadName(thread);
              const status = thread.loading ? "active" : "idle";

              return (
                <button
                  key={thread.id}
                  type="button"
                  className={`sidebar-thread-item${
                    selectedDetachedThreadId === thread.id ? " selected" : ""
                  }${thread.resolved ? " resolved" : ""}`}
                  onClick={() => onOpenDetachedThread(thread.id)}
                  title={name}
                >
                  <span className="sidebar-thread-row">
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
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              className={`sidebar-item${viewed[file.id] ? " viewed" : ""}`}
              onClick={() => onJumpToFile(file.id)}
            >
              <SidebarPathLabel
                path={file.displayPath}
                stats={
                  <DiffStats
                    additions={file.additions}
                    deletions={file.deletions}
                    className="sidebar-stats"
                  />
                }
              />
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

type SidebarPathLabelProps = {
  path: string;
  stats: ReactNode;
};

function SidebarPathLabel({ path, stats }: SidebarPathLabelProps) {
  const rowRef = useRef<HTMLSpanElement | null>(null);
  const pathRef = useRef<HTMLSpanElement | null>(null);
  const statsRef = useRef<HTMLSpanElement | null>(null);
  const [compactPath, setCompactPath] = useState(() =>
    initialSidebarPath(path),
  );
  const measure = useMemo(() => createTextMeasurer(), []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const pathElement = pathRef.current;
    const statsElement = statsRef.current;
    if (!row || !pathElement || !statsElement) {
      return;
    }

    const updateCompactPath = () => {
      const rowWidth = row.clientWidth;
      const statsWidth = statsElement.offsetWidth;
      const gap = 8;
      const availableWidth = rowWidth - statsWidth - gap;
      if (availableWidth <= 0) {
        setCompactPath(path);
        return;
      }

      const style = window.getComputedStyle(pathElement);
      setCompactPath(
        compactSidebarPath(path, availableWidth, style.font, measure),
      );
    };

    updateCompactPath();

    const observer = new ResizeObserver(updateCompactPath);
    observer.observe(row);
    observer.observe(statsElement);

    return () => {
      observer.disconnect();
    };
  }, [measure, path]);

  return (
    <span ref={rowRef} className="sidebar-row">
      <span ref={pathRef} className="sidebar-path" title={path}>
        {compactPath}
      </span>
      <span ref={statsRef}>{stats}</span>
    </span>
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

function initialSidebarPath(path: string): string {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  if (parts.length <= 2) {
    return path;
  }

  return `${parts[0]}/…/${name}`;
}

function compactSidebarPath(
  path: string,
  maxWidth: number,
  font: string,
  measure: (text: string, font: string) => number,
): string {
  const candidates = buildPathCandidates(path);
  for (const candidate of candidates) {
    if (measure(candidate, font) <= maxWidth) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1] ?? path;
}

function buildPathCandidates(path: string): string[] {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const dirs = parts;
  const candidates = [path];

  if (dirs.length > 0) {
    candidates.push(`${dirs.join("/")}/${name}`);
  }

  if (dirs.length > 2) {
    candidates.push(`${dirs[0]}/…/${dirs.slice(1).join("/")}/${name}`);
    candidates.push(`${dirs[0]}/…/${dirs.slice(-2).join("/")}/${name}`);
    candidates.push(`${dirs[0]}/…/${name}`);
    candidates.push(`${dirs[0]}/…/${dirs[dirs.length - 1]}/${name}`);
  }

  if (dirs.length > 0) {
    candidates.push(`…/${name}`);
    candidates.push(`…/${dirs[dirs.length - 1]}/${name}`);
  }

  const shortenedName = shortenFileName(name);
  if (dirs.length > 0) {
    candidates.push(`${dirs[0]}/…/${shortenedName}`);
    candidates.push(`${dirs[0]}/…/${dirs[dirs.length - 1]}/${shortenedName}`);
    candidates.push(`…/${shortenedName}`);
  }
  candidates.push(shortenedName);

  return [...new Set(candidates)];
}

function shortenFileName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 1 || dotIndex === name.length - 1) {
    return name.length <= 24 ? name : `${name.slice(0, 20)}…`;
  }

  const stem = name.slice(0, dotIndex);
  const ext = name.slice(dotIndex);
  if (stem.length <= 18) {
    return name;
  }

  return `${stem.slice(0, 14)}…${ext}`;
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
