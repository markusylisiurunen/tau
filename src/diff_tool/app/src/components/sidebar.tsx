import type { DiffFile } from "../parse_diff.js";
import "./sidebar.css";

type SidebarProps = {
  open: boolean;
  files: DiffFile[];
  viewed: Record<string, boolean>;
  onJumpToFile: (fileId: string) => void;
};

export function Sidebar({ open, files, viewed, onJumpToFile }: SidebarProps) {
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          className={`sidebar-item${viewed[file.id] ? " viewed" : ""}`}
          onClick={() => onJumpToFile(file.id)}
        >
          <span className="sidebar-path">{file.displayPath}</span>
          <span className="sidebar-stats">
            <span className="stat-add">+{file.additions}</span>
            <span className="stat-del">-{file.deletions}</span>
          </span>
        </button>
      ))}
    </aside>
  );
}
