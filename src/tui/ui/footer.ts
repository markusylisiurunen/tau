import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionProtocolFeedbackTone } from "../../protocol/session_protocol.js";
import { truncateFromEndByWidth } from "./components/one_line_segments.js";
import type { Theme } from "./theme/index.js";

export type FooterStatus =
  | {
      type: "regular";
      cwdLabel: string;
      contextUsage: string;
      sessionCost: string;
      duration: string;
      pursuingGoal: boolean;
    }
  | {
      type: "activity";
      label: string;
    };

const WORKING_ANIMATIONS = [
  ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"],
  ["⠽", "⠾", "⠷", "⠯", "⠟", "⠻"],
  ["⠋", "⠙", "⠚", "⠞", "⠖", "⠦", "⠴", "⠲", "⠳", "⠓"],
  ["⠄", "⠆", "⠇", "⠋", "⠙", "⠸", "⠰", "⠠", "⠰", "⠸", "⠙", "⠋", "⠇", "⠆"],
  [
    "⠀",
    "⠀",
    "⠁",
    "⠂",
    "⠄",
    "⠌",
    "⠔",
    "⠤",
    "⠥",
    "⠦",
    "⠮",
    "⠶",
    "⠷",
    "⠿",
    "⠿",
    "⠟",
    "⠛",
    "⠫",
    "⠋",
    "⠍",
    "⠉",
    "⠑",
    "⠡",
    "⠂",
    "⠄",
  ],
] as const;

const WORKING_FRAME_INTERVALS = [240, 240, 240, 240, 160] as const;
export const DEFAULT_FOOTER_NOTICE_DURATION_MS = 3000;
const COMPLETION_DURATION_MS = 3000;
const IDLE_ICON = "○";

export class FooterComponent implements Component {
  private readonly ui: TUI;
  private theme: Theme;
  private readonly random: () => number;

  private animation: readonly string[] = WORKING_ANIMATIONS[0]!;
  private lastAnimationIndex = -1;
  private animationFrame = 0;
  private animationMode: "working" | "activity" | null = null;
  private animationIntervalId: ReturnType<typeof setInterval> | null = null;
  private working = false;
  private completionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private noticeTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private status: FooterStatus | null = null;
  private notice: { text: string; tone: SessionProtocolFeedbackTone } | null = null;

  constructor(theme: Theme, ui: TUI, options: { random?: () => number } = {}) {
    this.theme = theme;
    this.ui = ui;
    this.random = options.random ?? Math.random;
  }

  setTheme(theme: Theme): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.ui.requestRender();
  }

  startWorkingIcon(): void {
    if (this.working) return;
    this.working = true;
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }
    this.syncAnimation();
  }

  stop(): void {
    if (!this.working) return;
    this.working = false;
    if (this.status?.type === "activity") {
      this.syncAnimation();
      return;
    }

    this.completionTimeoutId = setTimeout(() => {
      this.completionTimeoutId = null;
      this.ui.requestRender();
    }, COMPLETION_DURATION_MS);
    this.syncAnimation();
  }

  dispose(): void {
    this.stopAnimation();
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }
    if (this.noticeTimeoutId) {
      clearTimeout(this.noticeTimeoutId);
      this.noticeTimeoutId = null;
    }
  }

  setStatus(status: FooterStatus): void {
    this.status = status;
    this.syncAnimation();
  }

  showNotice(text: string, tone: SessionProtocolFeedbackTone, durationMs: number): void {
    if (this.noticeTimeoutId) {
      clearTimeout(this.noticeTimeoutId);
    }
    this.notice = { text, tone };
    this.syncAnimation();
    this.ui.requestRender();
    this.noticeTimeoutId = setTimeout(() => {
      this.notice = null;
      this.noticeTimeoutId = null;
      this.syncAnimation();
      this.ui.requestRender();
    }, durationMs);
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [""];

    const { palette } = this.theme;
    const notice = this.notice;
    if (notice) {
      const availableWidth = Math.max(0, width - 2);
      const text = truncateFromEndByWidth(notice.text, availableWidth);
      const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(text)));
      return [` ${this.getNoticeStyle(notice.tone)(text)}${padding} `];
    }

    if (this.status?.type === "activity") {
      const iconChar = this.animation[this.animationFrame % this.animation.length]!;
      const icon = palette.feedback(iconChar);
      const availableWidth = Math.max(0, width - visibleWidth(iconChar) - 3);
      const text = truncateFromEndByWidth(this.status.label.trim(), availableWidth);
      const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(text)));
      return [` ${icon} ${palette.feedback(text)}${padding} `];
    }

    const isCompleting = this.completionTimeoutId !== null;
    const iconChar = this.working
      ? this.animation[this.animationFrame % this.animation.length]!
      : isCompleting
        ? "●"
        : IDLE_ICON;
    const activityStyle = this.working || isCompleting ? palette.brandAccent : palette.textDim;
    const icon = activityStyle(iconChar);
    const iconWidth = visibleWidth(iconChar);
    const goalStatus = this.working && this.status?.pursuingGoal ? "goal" : "";
    const goalPrefix = goalStatus ? `${activityStyle(goalStatus)} ${palette.textDim("·")} ` : "";
    const goalPrefixWidth = goalStatus ? visibleWidth(goalStatus) + 3 : 0;
    const availableWidth = Math.max(0, width - iconWidth - goalPrefixWidth - 3);
    const text = truncateFromEndByWidth(this.buildStatusLine(availableWidth), availableWidth);
    const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(text)));

    return [` ${icon} ${goalPrefix}${palette.textDim(text)}${padding} `];
  }

  private syncAnimation(): void {
    const mode = this.notice
      ? null
      : this.status?.type === "activity"
        ? "activity"
        : this.working
          ? "working"
          : null;
    if (mode === this.animationMode) return;

    this.stopAnimation();
    this.animationMode = mode;
    if (!mode) {
      this.ui.requestRender();
      return;
    }
    if (mode === "activity" && this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }

    const animationIndex = this.selectAnimationIndex();
    this.animation = WORKING_ANIMATIONS[animationIndex]!;
    this.animationFrame = 0;
    this.ui.requestRender();
    this.animationIntervalId = setInterval(() => {
      this.animationFrame += 1;
      this.ui.requestRender();
    }, WORKING_FRAME_INTERVALS[animationIndex]!);
  }

  private stopAnimation(): void {
    if (this.animationIntervalId) {
      clearInterval(this.animationIntervalId);
      this.animationIntervalId = null;
    }
    this.animationFrame = 0;
    this.animationMode = null;
  }

  private selectAnimationIndex(): number {
    const randomIndex = Math.min(
      WORKING_ANIMATIONS.length - 1,
      Math.floor(this.random() * WORKING_ANIMATIONS.length),
    );
    const index =
      randomIndex === this.lastAnimationIndex
        ? (randomIndex + 1) % WORKING_ANIMATIONS.length
        : randomIndex;
    this.lastAnimationIndex = index;
    return index;
  }

  private buildStatusLine(availableWidth: number): string {
    if (this.status?.type !== "regular") return "";

    const { duration, cwdLabel, contextUsage, sessionCost } = this.status;
    const build = (cwd: string) =>
      [duration, cwd, contextUsage, sessionCost].filter(Boolean).join(" · ");
    const full = build(cwdLabel);
    if (visibleWidth(full) <= availableWidth) {
      return full;
    }

    const overflow = visibleWidth(full) - availableWidth;
    const cwdWidth = Math.max(1, visibleWidth(cwdLabel) - overflow);
    return build(compactCwdLabel(cwdLabel, cwdWidth));
  }

  private getNoticeStyle(tone: SessionProtocolFeedbackTone): (text: string) => string {
    const { palette } = this.theme;
    return tone === "error" ? palette.feedbackError : palette.feedback;
  }
}

function compactCwdLabel(label: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(label) <= maxWidth) return label;

  const remotePrefix = label.startsWith("remote · ") ? "remote · " : "";
  const path = remotePrefix ? label.slice(remotePrefix.length) : label;
  const basename = path.split("/").filter(Boolean).at(-1) ?? path;
  const root = path.startsWith("~/") ? "~/" : path.startsWith("/") ? "/" : "";
  const candidates = [
    `${remotePrefix}${root}…/${basename}`,
    `${root}…/${basename}`,
    `…/${basename}`,
    basename,
  ];

  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= maxWidth) {
      return candidate;
    }
  }

  return truncateFromStartByWidth(basename, maxWidth);
}

function truncateFromStartByWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  let suffix = "";
  for (const character of Array.from(text).reverse()) {
    if (visibleWidth(`…${character}${suffix}`) > maxWidth) break;
    suffix = `${character}${suffix}`;
  }
  return `…${suffix}`;
}
