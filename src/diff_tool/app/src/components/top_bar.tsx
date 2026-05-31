import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  EyeOff,
  MessageSquare,
  PanelLeft,
  ScrollText,
  X,
} from "lucide-react";
import { DiffStats } from "./diff_stats.js";
import "./top_bar.css";
import { IconButton } from "./icon_button.js";
import { ToggleGroup } from "./toggle_group.js";

type TopBarProps = {
  fileCount: number;
  viewedCount: number;
  additions: number;
  deletions: number;
  commentCount: number;
  diffArgs?: string[];
  diffCommand?: string;
  diffStyle: "stacked" | "split";
  overflowMode: "wrap" | "scroll";
  sidebarOpen: boolean;
  finished: boolean;
  status: string;
  briefLoading: boolean;
  hasBrief: boolean;
  hasUnresolvedFileThreads: boolean;
  onBriefClick: () => void;
  onToggleSidebar: () => void;
  onExpandAll: () => void;
  onExpandUnresolved: () => void;
  onCollapseViewed: () => void;
  onCollapseAll: () => void;
  onDiffStyleChange: (style: "stacked" | "split") => void;
  onOverflowModeChange: (mode: "wrap" | "scroll") => void;
  onSubmit: () => void;
  onOpenSubmitPopover: (anchor: DOMRect) => void;
  onCancel: () => void;
};

type DiffScopeSummary = {
  label: string;
  title: string;
};

const compactDiffCommandLength = 48;

function summarizeDiffScope(
  diffCommand: string | undefined,
  diffArgs: string[] | undefined,
): DiffScopeSummary | undefined {
  const title = diffCommand?.trim();
  if (!title) {
    return undefined;
  }

  const args = diffArgs ?? [];
  if (args.length === 0 || title === "current working tree") {
    return { label: "current working tree", title };
  }

  if (title.length <= compactDiffCommandLength) {
    return { label: title, title };
  }

  const pathspecIndex = args.indexOf("--");
  const diffArgsOnly = pathspecIndex >= 0 ? args.slice(0, pathspecIndex) : args;
  const paths = pathspecIndex >= 0 ? args.slice(pathspecIndex + 1) : [];
  const range = diffArgsOnly.find(
    (arg) => arg !== "--" && !arg.startsWith("-"),
  );

  if (range && paths.length > 0) {
    return { label: `${range} · ${formatPathCount(paths.length)}`, title };
  }
  if (range) {
    return { label: `git diff ${range}`, title };
  }
  if (paths.length > 0) {
    return { label: `working tree · ${formatPathCount(paths.length)}`, title };
  }

  return { label: "custom diff", title };
}

function formatPathCount(count: number): string {
  return `${count} path${count === 1 ? "" : "s"}`;
}

export function TopBar({
  fileCount,
  viewedCount,
  additions,
  deletions,
  commentCount,
  diffArgs,
  diffCommand,
  diffStyle,
  overflowMode,
  sidebarOpen,
  finished,
  status,
  briefLoading,
  hasBrief,
  hasUnresolvedFileThreads,
  onBriefClick,
  onToggleSidebar,
  onExpandAll,
  onExpandUnresolved,
  onCollapseViewed,
  onCollapseAll,
  onDiffStyleChange,
  onOverflowModeChange,
  onSubmit,
  onOpenSubmitPopover,
  onCancel,
}: TopBarProps) {
  const resolvedDiffStyle = diffStyle === "split" ? "split" : "stacked";
  const resolvedOverflowMode = overflowMode === "scroll" ? "scroll" : "wrap";
  const viewedProgress =
    fileCount > 0 ? Math.round((viewedCount / fileCount) * 100) : 0;
  const diffScope = summarizeDiffScope(diffCommand, diffArgs);

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <IconButton
          icon={PanelLeft}
          label="Toggle sidebar"
          className={sidebarOpen ? "active" : ""}
          onClick={onToggleSidebar}
        />
        <button
          type="button"
          className="btn top-bar-action top-bar-brief-action"
          onClick={onBriefClick}
          disabled={briefLoading}
        >
          <ScrollText size={14} />
          {briefLoading
            ? "generating brief…"
            : hasBrief
              ? "view brief"
              : "brief"}
        </button>
        <div
          className="top-bar-diff-meta"
          aria-label={`${additions} additions and ${deletions} deletions${diffScope ? `, ${diffScope.title}` : ""}`}
        >
          <DiffStats additions={additions} deletions={deletions} />
          {diffScope && (
            <span
              className="top-bar-meta top-bar-meta-dim top-bar-diff-command"
              title={diffScope.title}
            >
              {diffScope.label}
            </span>
          )}
        </div>
      </div>
      <div className="top-bar-right">
        <div
          className="top-bar-viewed"
          aria-label={`${viewedCount} of ${fileCount} viewed, ${commentCount} unresolved comments`}
        >
          <span
            className="top-bar-viewed-ring"
            style={{
              background: `conic-gradient(var(--accent-add) ${viewedProgress}%, var(--border) ${viewedProgress}% 100%)`,
            }}
            aria-hidden="true"
          >
            <span className="top-bar-viewed-ring-inner" />
          </span>
          <span className="top-bar-viewed-text">
            {viewedCount} of {fileCount} viewed
          </span>
        </div>
        {status && (
          <span className="top-bar-meta top-bar-status">{status}</span>
        )}
        <div className="btn-group">
          <IconButton
            icon={ChevronsUpDown}
            label="Expand all files"
            onClick={onExpandAll}
          />
          <IconButton
            icon={MessageSquare}
            label="Expand files with unresolved threads"
            onClick={onExpandUnresolved}
            disabled={!hasUnresolvedFileThreads}
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
        <button
          type="button"
          className={`top-bar-toggle${resolvedOverflowMode === "wrap" ? " active" : ""}`}
          onClick={() =>
            onOverflowModeChange(
              resolvedOverflowMode === "wrap" ? "scroll" : "wrap",
            )
          }
          aria-pressed={resolvedOverflowMode === "wrap"}
          aria-label="Toggle wrapped diff lines"
        >
          <span className="top-bar-toggle-switch" aria-hidden="true">
            <span className="top-bar-toggle-thumb" />
          </span>
          <span className="top-bar-toggle-label">wrap</span>
        </button>
        <ToggleGroup
          value={resolvedDiffStyle}
          options={[
            { value: "split", label: "split" },
            { value: "stacked", label: "stacked" },
          ]}
          onChange={onDiffStyleChange}
        />
        <div className="top-bar-submit-group">
          <button
            type="button"
            className="btn top-bar-action top-bar-action-primary top-bar-submit-main"
            onClick={onSubmit}
            disabled={finished}
          >
            submit
          </button>
          <button
            type="button"
            className="btn top-bar-action top-bar-action-primary top-bar-submit-menu"
            onClick={(event) =>
              onOpenSubmitPopover(event.currentTarget.getBoundingClientRect())
            }
            disabled={finished}
            aria-label="submit with message"
          >
            <ChevronDown size={14} />
          </button>
        </div>
        <button
          type="button"
          className="btn top-bar-action top-bar-action-cancel"
          onClick={onCancel}
          disabled={finished}
          aria-label="cancel"
        >
          <X size={14} strokeWidth={2.25} />
        </button>
      </div>
    </header>
  );
}
