import {
  ChevronsDownUp,
  ChevronsUpDown,
  EyeOff,
  MessageSquare,
  X,
} from "lucide-react";
import { Button } from "../../ui/button.js";
import { Switch } from "../../ui/switch.js";
import type { DiffStyle, OverflowMode } from "../../types.js";
import { ToggleGroup } from "../../ui/toggle_group.js";
import { DiffStats } from "../diff/diff_stats.js";
import type { ReviewMode } from "./use_review_navigation.js";
import "./top_bar.css";

type TopBarProps = {
  mode: ReviewMode;
  fileCount: number;
  viewedCount: number;
  additions: number;
  deletions: number;
  commentCount: number;
  diffStyle: DiffStyle;
  overflowMode: OverflowMode;
  finished: boolean;
  hasUnresolvedFileThreads: boolean;
  onModeChange: (mode: ReviewMode) => void;
  onExpandAll: () => void;
  onExpandUnresolved: () => void;
  onCollapseViewed: () => void;
  onCollapseAll: () => void;
  onDiffStyleChange: (style: DiffStyle) => void;
  onOverflowModeChange: (mode: OverflowMode) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

const reviewModeOptions: Array<{ value: ReviewMode; label: string }> = [
  { value: "guide", label: "Guide" },
  { value: "diff", label: "Diff" },
];

const diffStyleOptions: Array<{ value: DiffStyle; label: string }> = [
  { value: "split", label: "Split" },
  { value: "stacked", label: "Stacked" },
];

const topBarIconSize = 14;

export function TopBar({
  mode,
  fileCount,
  viewedCount,
  additions,
  deletions,
  commentCount,
  diffStyle,
  overflowMode,
  finished,
  hasUnresolvedFileThreads,
  onModeChange,
  onExpandAll,
  onExpandUnresolved,
  onCollapseViewed,
  onCollapseAll,
  onDiffStyleChange,
  onOverflowModeChange,
  onSubmit,
  onCancel,
}: TopBarProps) {
  const resolvedDiffStyle = diffStyle === "split" ? "split" : "stacked";
  const resolvedOverflowMode = overflowMode === "scroll" ? "scroll" : "wrap";
  const viewedProgress =
    fileCount > 0 ? Math.round((viewedCount / fileCount) * 100) : 0;

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <ToggleGroup
          value={mode}
          options={reviewModeOptions}
          label="Review mode"
          onChange={onModeChange}
        />
      </div>
      <div className="top-bar-right">
        {mode === "diff" && (
          <>
            <span
              aria-label={`${additions} additions and ${deletions} deletions`}
            >
              <DiffStats additions={additions} deletions={deletions} />
            </span>
            <div
              className="top-bar-viewed"
              aria-label={`${viewedCount} of ${fileCount} viewed, ${commentCount} unresolved comments`}
            >
              <span
                className="top-bar-viewed-ring"
                style={{
                  background: `conic-gradient(var(--accent-interactive) ${viewedProgress}%, var(--border) ${viewedProgress}% 100%)`,
                }}
                aria-hidden="true"
              >
                <span className="top-bar-viewed-ring-inner" />
              </span>
              <span className="top-bar-viewed-text">
                {viewedCount} of {fileCount} viewed
              </span>
            </div>
            <div className="button-group">
              <Button
                variant="ghost"
                iconOnly
                aria-label="Expand all files"
                onClick={onExpandAll}
              >
                <ChevronsUpDown size={topBarIconSize} />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label="Expand files with unresolved threads"
                onClick={onExpandUnresolved}
                disabled={!hasUnresolvedFileThreads}
              >
                <MessageSquare size={topBarIconSize} />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label="Collapse viewed files"
                onClick={onCollapseViewed}
              >
                <EyeOff size={topBarIconSize} />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label="Collapse all files"
                onClick={onCollapseAll}
              >
                <ChevronsDownUp size={topBarIconSize} />
              </Button>
            </div>
            <Switch
              checked={resolvedOverflowMode === "wrap"}
              label="Wrap"
              onChange={(checked) =>
                onOverflowModeChange(checked ? "wrap" : "scroll")
              }
            />
            <ToggleGroup
              value={resolvedDiffStyle}
              options={diffStyleOptions}
              label="Diff style"
              onChange={onDiffStyleChange}
            />
          </>
        )}
        <div className="top-bar-actions">
          <Button variant="primary" onClick={onSubmit} disabled={finished}>
            Submit
          </Button>
          <Button
            variant="danger"
            iconOnly
            onClick={onCancel}
            disabled={finished}
            aria-label="cancel"
          >
            <X size={topBarIconSize} strokeWidth={2.25} />
          </Button>
        </div>
      </div>
    </header>
  );
}
