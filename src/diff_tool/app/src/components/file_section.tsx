import { FileDiff } from "@pierre/diffs/react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useMemo } from "react";
import type {
  CommentAnnotation,
  LineAnnotation,
  LineSide,
} from "../comments.js";
import type { DiffFile } from "../parse_diff.js";
import type { DiffStyle, OverflowMode } from "../types.js";
import { CommentEditor } from "./comment_editor.js";
import { DiffStats } from "./diff_stats.js";
import { ThreadCard } from "./thread_card.js";
import "./file_section.css";

const baseDiffOptions = {
  theme: "github-dark-default",
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "none",
  lineDiffType: "word-alt",
  disableFileHeader: true,
  overflow: "wrap",
  unsafeCSS: [
    ":host { --diffs-dark-bg: var(--bg); --diffs-bg: var(--bg); font-weight: var(--font-weight-code); }",
    "pre { background-color: var(--bg) !important; --diffs-bg: var(--bg) !important; }",
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
  collapsed: boolean;
  viewed: boolean;
  annotations: LineAnnotation[];
  onToggleCollapsed: (id: string) => void;
  onToggleViewed: (id: string) => void;
  onLineActivate: (fileId: string, lineNumber: number, side: LineSide) => void;
  onDraftChange: (body: string) => void;
  onSaveDraft: () => void;
  onCancelDraft: () => void;
  onAddReply: (threadId: string, text: string) => void;
  onRequestAgent: (threadId: string) => void;
  onToggleResolved: (threadId: string, resolved: boolean) => void;
  onToggleThreadCollapsed: (threadId: string, collapsed: boolean) => void;
};

export function FileSection({
  file,
  diffStyle,
  overflowMode,
  collapsed,
  viewed,
  annotations,
  onToggleCollapsed,
  onToggleViewed,
  onLineActivate,
  onDraftChange,
  onSaveDraft,
  onCancelDraft,
  onAddReply,
  onRequestAgent,
  onToggleResolved,
  onToggleThreadCollapsed,
}: FileSectionProps) {
  const options = useMemo(() => {
    const resolvedDiffStyle = (diffStyle === "split" ? "split" : "unified") as
      | "split"
      | "unified";

    return {
      ...baseDiffOptions,
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
  }, [diffStyle, file.id, onLineActivate, overflowMode]);

  const renderAnnotation = useCallback(
    (annotation: LineAnnotation) => {
      if (annotation.metadata.type === "draft") {
        return (
          <CommentEditor
            body={annotation.metadata.draft.body}
            onChange={onDraftChange}
            onSave={onSaveDraft}
            onCancel={onCancelDraft}
          />
        );
      }

      const { thread } = annotation.metadata;
      return (
        <ThreadCard
          thread={thread}
          onAddReply={(text) => onAddReply(thread.id, text)}
          onRequestAgent={() => onRequestAgent(thread.id)}
          onToggleResolved={(resolved) => onToggleResolved(thread.id, resolved)}
          onToggleCollapsed={(nextCollapsed) =>
            onToggleThreadCollapsed(thread.id, nextCollapsed)
          }
        />
      );
    },
    [
      onAddReply,
      onCancelDraft,
      onDraftChange,
      onRequestAgent,
      onSaveDraft,
      onToggleResolved,
      onToggleThreadCollapsed,
    ],
  );

  return (
    <section className="file-section" id={`file-${file.id}`}>
      <div className="file-header">
        <button
          type="button"
          className="file-toggle"
          onClick={() => onToggleCollapsed(file.id)}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className="file-path">{file.displayPath}</span>
        </button>
        <div className="file-meta">
          <DiffStats additions={file.additions} deletions={file.deletions} />
          <button
            type="button"
            className={`viewed-btn${viewed ? " checked" : ""}`}
            onClick={() => onToggleViewed(file.id)}
            aria-label={viewed ? "Mark as not viewed" : "Mark as viewed"}
          >
            <span className="viewed-check">
              {viewed && <Check size={10} strokeWidth={3} />}
            </span>
            viewed
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="file-body">
          <FileDiff<CommentAnnotation>
            className="diff-view"
            fileDiff={file.file}
            options={options}
            lineAnnotations={annotations}
            renderAnnotation={renderAnnotation}
          />
        </div>
      )}
    </section>
  );
}
