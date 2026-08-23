import { FileDiff, MessagesSquare } from "lucide-react";
import type { CommentThread } from "./comments.js";
import type { DiffFile } from "./parse_diff.js";
import { DiffStats } from "./diff_stats.js";
import { SidebarDirectoryLabel } from "./sidebar_directory_label.js";
import "./sidebar.css";

type SidebarProps = {
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
    <aside className="sidebar">
      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <h2 className="sidebar-section-title">Threads</h2>
          <button
            type="button"
            className="sidebar-action"
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

              const selected = selectedThreadId === thread.id;

              return (
                <button
                  key={thread.id}
                  type="button"
                  className={`sidebar-thread-item${selected ? " selected" : ""}${thread.resolved ? " resolved" : ""}`}
                  aria-current={selected || undefined}
                  onClick={() => onOpenThread(thread)}
                  title={name}
                >
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
                </button>
              );
            })
          )}
        </div>
      </section>
      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <h2 className="sidebar-section-title">Files</h2>
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
                  className={`sidebar-file-item${viewed[file.id] ? " viewed" : ""}`}
                  onClick={() => onJumpToFile(file.id)}
                  title={file.displayPath}
                >
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
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>
    </aside>
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
