import {
  ChevronsDownUp,
  ChevronsUpDown,
  EyeOff,
  MessageSquarePlus,
  PanelLeft,
  Send,
  X,
} from "lucide-react";
import "./button.css";
import "./top_bar.css";
import { IconButton } from "./icon_button.js";
import { ToggleGroup } from "./toggle_group.js";

type TopBarProps = {
  fileCount: number;
  viewedCount: number;
  additions: number;
  deletions: number;
  commentCount: number;
  diffCommand?: string;
  diffStyle: "unified" | "split";
  sidebarOpen: boolean;
  finished: boolean;
  status: string;
  onToggleSidebar: () => void;
  onExpandAll: () => void;
  onCollapseViewed: () => void;
  onCollapseAll: () => void;
  onDiffStyleChange: (style: "unified" | "split") => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function TopBar({
  fileCount,
  viewedCount,
  additions,
  deletions,
  commentCount,
  diffCommand,
  diffStyle,
  sidebarOpen,
  finished,
  status,
  onToggleSidebar,
  onExpandAll,
  onCollapseViewed,
  onCollapseAll,
  onDiffStyleChange,
  onSubmit,
  onCancel,
}: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <IconButton
          icon={PanelLeft}
          label="Toggle file list"
          className={sidebarOpen ? "active" : ""}
          onClick={onToggleSidebar}
        />
        <span className="meta">
          {viewedCount}/{fileCount}
        </span>
        <span className="stat-add">+{additions}</span>
        <span className="stat-del">-{deletions}</span>
        {commentCount > 0 && (
          <span className="meta comment-count">
            <MessageSquarePlus size={12} />
            {commentCount}
          </span>
        )}
        {diffCommand && <span className="meta dim">{diffCommand}</span>}
      </div>
      <div className="top-bar-right">
        {status && <span className="meta status-text">{status}</span>}
        <div className="btn-group">
          <IconButton
            icon={ChevronsUpDown}
            label="Expand all files"
            onClick={onExpandAll}
          />
          <IconButton
            icon={EyeOff}
            label="Collapse viewed files"
            onClick={onCollapseViewed}
          />
          <IconButton
            icon={ChevronsDownUp}
            label="Collapse all files"
            onClick={onCollapseAll}
          />
        </div>
        <ToggleGroup
          value={diffStyle}
          options={["split", "unified"]}
          onChange={onDiffStyleChange}
        />
        <button
          type="button"
          className="btn primary"
          onClick={onSubmit}
          disabled={finished}
        >
          <Send size={12} />
          submit
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={onCancel}
          disabled={finished}
        >
          <X size={12} />
          cancel
        </button>
      </div>
    </header>
  );
}
