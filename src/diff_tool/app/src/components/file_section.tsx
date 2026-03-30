import { FileDiff } from "@pierre/diffs/react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useMemo } from "react";
import type {
  CommentAnnotation,
  CommentDraft,
  CommentThread,
  LineAnnotation,
  LineSide,
} from "../comments.js";
import type { DiffFile } from "../parse_diff.js";
import { CommentEditor } from "./comment_editor.js";
import { ThreadCard } from "./thread_card.js";
import "./file_section.css";

const baseDiffOptions = {
  theme: "github-dark-default",
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "none",
  lineDiffType: "none",
  disableFileHeader: true,
  overflow: "wrap",
  unsafeCSS:
    ":host { --diffs-dark-bg: #0e0e0e; --diffs-bg: #0e0e0e; } pre { background-color: #0e0e0e !important; --diffs-bg: #0e0e0e !important; }",
} as const;

type FileSectionProps = {
  file: DiffFile;
  diffStyle: "unified" | "split";
  collapsed: boolean;
  viewed: boolean;
  annotations: LineAnnotation[];
  onToggleCollapsed: (id: string) => void;
  onToggleViewed: (id: string) => void;
  onLineActivate: (fileId: string, lineNumber: number, side: LineSide) => void;
  onDraftChange: (body: string) => void;
  onSaveDraft: () => void;
  onCancelDraft: () => void;
  onDeleteThread: (threadId: string) => void;
  onAddReply: (threadId: string, text: string) => void;
  onRequestAgent: (threadId: string) => void;
};

export function FileSection({
  file,
  diffStyle,
  collapsed,
  viewed,
  annotations,
  onToggleCollapsed,
  onToggleViewed,
  onLineActivate,
  onDraftChange,
  onSaveDraft,
  onCancelDraft,
  onDeleteThread,
  onAddReply,
  onRequestAgent,
}: FileSectionProps) {
  const options = useMemo(
    () => ({
      ...baseDiffOptions,
      diffStyle,
      onLineNumberClick: ({
        lineNumber,
        annotationSide,
      }: {
        lineNumber: number;
        annotationSide: LineSide;
      }) => {
        onLineActivate(file.id, lineNumber, annotationSide);
      },
    }),
    [diffStyle, file.id, onLineActivate],
  );

  const renderAnnotation = useCallback(
    (annotation: LineAnnotation) => {
      const meta = annotation.metadata;
      if (meta.type === "draft") {
        return (
          <CommentEditor
            body={meta.draft.body}
            onChange={onDraftChange}
            onSave={onSaveDraft}
            onCancel={onCancelDraft}
          />
        );
      }
      return (
        <ThreadCard
          thread={meta.thread}
          onDelete={() => onDeleteThread(meta.thread.id)}
          onAddReply={(text) => onAddReply(meta.thread.id, text)}
          onRequestAgent={() => onRequestAgent(meta.thread.id)}
        />
      );
    },
    [
      onDraftChange,
      onSaveDraft,
      onCancelDraft,
      onDeleteThread,
      onAddReply,
      onRequestAgent,
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
          <span className="stat-add">+{file.additions}</span>
          <span className="stat-del">-{file.deletions}</span>
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
