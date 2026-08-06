import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { truncateFromEndByWidth } from "./components/one_line_segments.js";
import type { SystemMessageKind } from "./system_message.js";
import type { Theme } from "./theme/index.js";

export interface FooterStatus {
  cwdLabel: string;
  contextUsage: string;
  sessionCost: string;
  duration: string;
  statusHint?: string;
  pursuingGoal: boolean;
}

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

const WORKING_FRAME_INTERVALS = [120, 120, 120, 120, 80] as const;
const COMPLETION_DURATION_MS = 3000;

export class FooterComponent implements Component {
  private ui: TUI;
  private theme: Theme;
  private readonly random: () => number;

  private idleIcon = "○";
  private workingAnimation: readonly string[] = WORKING_ANIMATIONS[0]!;
  private lastWorkingAnimationIndex = -1;
  private currentAnimationFrame = 0;
  private iconIntervalId: ReturnType<typeof setInterval> | null = null;
  private completionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private toastTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private status: FooterStatus | null = null;
  private toast: { text: string; kind: SystemMessageKind } | null = null;

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
    if (this.iconIntervalId) return;
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }

    const animationIndex = this.selectWorkingAnimationIndex();
    this.workingAnimation = WORKING_ANIMATIONS[animationIndex]!;
    this.currentAnimationFrame = 0;
    this.requestAnimationRender();
    this.iconIntervalId = setInterval(() => {
      this.currentAnimationFrame += 1;
      this.requestAnimationRender();
    }, WORKING_FRAME_INTERVALS[animationIndex]!);
  }

  stop(): void {
    if (!this.iconIntervalId) return;

    clearInterval(this.iconIntervalId);
    this.iconIntervalId = null;
    this.currentAnimationFrame = 0;
    this.requestAnimationRender();
    this.completionTimeoutId = setTimeout(() => {
      this.completionTimeoutId = null;
      this.requestAnimationRender();
    }, COMPLETION_DURATION_MS);
  }

  dispose(): void {
    if (this.iconIntervalId) {
      clearInterval(this.iconIntervalId);
      this.iconIntervalId = null;
    }
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }
    if (this.toastTimeoutId) {
      clearTimeout(this.toastTimeoutId);
      this.toastTimeoutId = null;
    }
  }

  setStatus(status: FooterStatus): void {
    this.status = status;
  }

  showToast(text: string, kind: SystemMessageKind, durationMs: number = 3000): void {
    if (this.toastTimeoutId) {
      clearTimeout(this.toastTimeoutId);
    }
    this.toast = { text, kind };
    this.ui.requestRender();
    this.toastTimeoutId = setTimeout(() => {
      this.toast = null;
      this.toastTimeoutId = null;
      this.ui.requestRender();
    }, durationMs);
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [""];

    const { palette } = this.theme;
    const isWorking = this.iconIntervalId !== null;
    const isCompleting = this.completionTimeoutId !== null;
    const iconChar = isWorking
      ? this.workingAnimation[this.currentAnimationFrame % this.workingAnimation.length]!
      : isCompleting
        ? "●"
        : this.idleIcon;
    const activityStyle = isWorking || isCompleting ? palette.brandAccent : palette.textDim;
    const icon = activityStyle(iconChar);
    const iconWidth = visibleWidth(iconChar);
    const availableWidth = Math.max(0, width - iconWidth - 3);
    const toast = this.toast;
    const statusHint = this.status?.statusHint?.trim();
    const goalStatus = isWorking && this.status?.pursuingGoal ? "pursuing goal" : "";
    const transientText = toast?.text ?? statusHint ?? goalStatus;
    const rawText = transientText || this.buildStatusLine(availableWidth);
    const style = toast
      ? this.getToastStyle(toast.kind)
      : goalStatus && rawText === goalStatus
        ? activityStyle
        : palette.textDim;
    const text = truncateFromEndByWidth(rawText, availableWidth);
    const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(text)));

    return [` ${icon} ${style(text)}${padding} `];
  }

  private selectWorkingAnimationIndex(): number {
    const randomIndex = Math.min(
      WORKING_ANIMATIONS.length - 1,
      Math.floor(this.random() * WORKING_ANIMATIONS.length),
    );
    const index =
      randomIndex === this.lastWorkingAnimationIndex
        ? (randomIndex + 1) % WORKING_ANIMATIONS.length
        : randomIndex;
    this.lastWorkingAnimationIndex = index;
    return index;
  }

  private requestAnimationRender(): void {
    this.ui.requestRender();
  }

  private buildStatusLine(availableWidth: number): string {
    if (!this.status) return "";

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

  private getToastStyle(kind: SystemMessageKind): (text: string) => string {
    const { palette } = this.theme;
    if (kind === "error") return palette.toastError;
    if (kind === "warn") return palette.toastWarn;
    if (kind === "muted") return palette.textMuted;
    return palette.toastSuccess;
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
