import type { DiffFile } from "./parse_diff.js";
import { DiffStats } from "./diff_stats.js";
import { SidebarDirectoryLabel } from "./sidebar_directory_label.js";
import "./sidebar.css";

type SidebarProps = {
  files: DiffFile[];
  viewed: Record<string, boolean>;
  onJumpToFile: (fileId: string) => void;
};

type SidebarFileGroup = {
  directory: string;
  files: DiffFile[];
};

export function Sidebar({ files, viewed, onJumpToFile }: SidebarProps) {
  const fileGroups = groupSidebarFiles(files);

  return (
    <aside className="sidebar">
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
