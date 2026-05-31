import { FileDiff } from "@pierre/diffs/react";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import type {
  CommentAnnotation,
  LineAnnotation,
  LineSide,
} from "../comments.js";
import type { DiffFile } from "../parse_diff.js";
import {
  DEFAULT_DIFF_TOOL_CODE_THEME,
  type CodeTheme,
  type DiffStyle,
  type OverflowMode,
} from "../types.js";
import { Checkbox } from "./checkbox.js";
import { CommentEditor } from "./comment_editor.js";
import { DiffStats } from "./diff_stats.js";
import { ThreadCard } from "./thread_card.js";
import "./file_section.css";

const baseDiffOptions = {
  theme: DEFAULT_DIFF_TOOL_CODE_THEME,
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "none",
  hunkSeparators: "line-info-basic",
  lineDiffType: "word-alt",
  disableFileHeader: true,
  overflow: "wrap",
  unsafeCSS: [
    ":host { --diffs-dark-bg: var(--bg); --diffs-bg: var(--bg); --diffs-annotation-bg-override: color-mix(in srgb, var(--bg) 96%, var(--text)); --diffs-bg-separator-override: color-mix(in srgb, var(--bg) 92%, var(--text)); --diffs-bg-context-override: var(--diffs-annotation-bg-override); --diffs-bg-context-gutter-override: var(--diffs-annotation-bg-override); font-weight: var(--font-weight-code); }",
    "pre { background-color: var(--bg) !important; --diffs-bg: var(--bg) !important; }",
    "[data-line-annotation], [data-gutter-buffer='annotation'] { --diffs-annotation-bg: var(--diffs-annotation-bg-override); }",
    "[data-annotation-slot], [data-annotation-content] { font-family: var(--font-family-ui); }",
    "[data-annotation-slot] code, [data-annotation-slot] pre, [data-annotation-content] code, [data-annotation-content] pre { font-family: var(--font-family-code); }",
    "[data-overflow='wrap'] [data-code] { overflow-x: hidden; }",
    "[data-overflow='wrap'] [data-annotation-content] { width: auto; }",
  ].join(" "),
} as const;

type FileSectionProps = {
  file: DiffFile;
  diffStyle: DiffStyle;
  overflowMode: OverflowMode;
  codeTheme: CodeTheme;
  collapsed: boolean;
  viewed: boolean;
  annotations: LineAnnotation[];
  unresolvedThreadCount: number;
  renderReady: boolean;
  onToggleCollapsed: (id: string) => void;
  onToggleViewed: (id: string) => void;
  onLineActivate: (fileId: string, lineNumber: number, side: LineSide) => void;
  onSaveDraft: (body: string, requestAgent: boolean) => void;
  onCancelDraft: () => void;
  onAddReply: (threadId: string, text: string, requestAgent: boolean) => void;
  onRequestAgent: (threadId: string) => void;
  onToggleResolved: (threadId: string, resolved: boolean) => void;
  onToggleThreadCollapsed: (threadId: string, collapsed: boolean) => void;
  onDeleteThreadMessage: (threadId: string, messageIndex: number) => void;
};

export const FileSection = memo(function FileSection({
  file,
  diffStyle,
  overflowMode,
  codeTheme,
  collapsed,
  viewed,
  annotations,
  unresolvedThreadCount,
  renderReady,
  onToggleCollapsed,
  onToggleViewed,
  onLineActivate,
  onSaveDraft,
  onCancelDraft,
  onAddReply,
  onRequestAgent,
  onToggleResolved,
  onToggleThreadCollapsed,
  onDeleteThreadMessage,
}: FileSectionProps) {
  const options = useMemo(() => {
    const resolvedDiffStyle = (diffStyle === "split" ? "split" : "unified") as
      | "split"
      | "unified";

    return {
      ...baseDiffOptions,
      theme: codeTheme,
      diffStyle: resolvedDiffStyle,
      overflow: overflowMode,
      onLineNumberClick: ({
        lineNumber,
        annotationSide,
      }: {
        lineNumber: number;
        annotationSide: LineSide;
      }) => {
        onLineActivate(file.id, lineNumber, annotationSide);
      },
    };
  }, [codeTheme, diffStyle, file.id, onLineActivate, overflowMode]);

  const renderAnnotation = useCallback(
    (annotation: LineAnnotation) => {
      if (annotation.metadata.type === "draft") {
        return <CommentEditor onSave={onSaveDraft} onCancel={onCancelDraft} />;
      }

      const { thread } = annotation.metadata;
      return (
        <ThreadCard
          thread={thread}
          onAddReply={(text, requestAgent) =>
            onAddReply(thread.id, text, requestAgent)
          }
          onRequestAgent={() => onRequestAgent(thread.id)}
          onToggleResolved={(resolved) => onToggleResolved(thread.id, resolved)}
          onToggleCollapsed={(nextCollapsed) =>
            onToggleThreadCollapsed(thread.id, nextCollapsed)
          }
          onDeleteMessage={(messageIndex) =>
            onDeleteThreadMessage(thread.id, messageIndex)
          }
        />
      );
    },
    [
      onAddReply,
      onCancelDraft,
      onRequestAgent,
      onSaveDraft,
      onDeleteThreadMessage,
      onToggleResolved,
      onToggleThreadCollapsed,
    ],
  );

  return (
    <section
      className={`file-section${collapsed ? " collapsed" : ""}`}
      id={`file-${file.id}`}
    >
      <div className="file-header">
        <button
          type="button"
          className="file-toggle"
          onClick={() => onToggleCollapsed(file.id)}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className="file-path">{file.displayPath}</span>
          {unresolvedThreadCount > 0 && (
            <span
              className="file-thread-count"
              aria-label={`${unresolvedThreadCount} unresolved comment thread${unresolvedThreadCount === 1 ? "" : "s"}`}
              title={`${unresolvedThreadCount} unresolved comment thread${unresolvedThreadCount === 1 ? "" : "s"}`}
            >
              <MessageSquare size={12} />
              <span>{unresolvedThreadCount}</span>
            </span>
          )}
        </button>
        <div className="file-meta">
          <DiffStats additions={file.additions} deletions={file.deletions} />
          <Checkbox
            checked={viewed}
            label="viewed"
            className="viewed-checkbox"
            onChange={() => onToggleViewed(file.id)}
          />
        </div>
      </div>
      {!collapsed && (
        <div className="file-body">
          {renderReady ? (
            <FileDiff<CommentAnnotation>
              className="diff-view"
              fileDiff={file.file}
              options={options}
              lineAnnotations={annotations}
              renderAnnotation={renderAnnotation}
            />
          ) : (
            <div className="diff-placeholder">preparing diff…</div>
          )}
        </div>
      )}
    </section>
  );
});
