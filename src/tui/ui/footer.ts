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

export class FooterComponent implements Component {
  private ui: TUI;
  private theme: Theme;

  private idleIcon = "○";
  private iconFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentIconFrame = 0;
  private iconIntervalId: ReturnType<typeof setInterval> | null = null;
  private toastTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private status: FooterStatus | null = null;
  private toast: { text: string; kind: SystemMessageKind } | null = null;

  constructor(theme: Theme, ui: TUI) {
    this.theme = theme;
    this.ui = ui;
  }

  setTheme(theme: Theme): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.ui.requestRender();
  }

  startWorkingIcon() {
    if (this.iconIntervalId) return;
    this.currentIconFrame = 0;
    this.ui.requestRender();
    this.iconIntervalId = setInterval(() => {
      this.currentIconFrame = (this.currentIconFrame + 1) % this.iconFrames.length;
      this.ui.requestRender();
    }, 80);
  }

  stop() {
    if (this.iconIntervalId) {
      clearInterval(this.iconIntervalId);
      this.iconIntervalId = null;
    }
    this.currentIconFrame = 0;
    this.ui.requestRender();
  }

  setStatus(status: FooterStatus) {
    this.status = status;
  }

  showToast(text: string, kind: SystemMessageKind, durationMs: number = 3000) {
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

  invalidate() {}

  render(width: number) {
    if (width <= 0) return [""];

    const { palette } = this.theme;
    const iconChar = this.iconIntervalId ? this.iconFrames[this.currentIconFrame]! : this.idleIcon;
    const activityStyle = this.iconIntervalId ? palette.brandAccent : palette.textDim;
    const icon = activityStyle(iconChar);
    const iconWidth = visibleWidth(iconChar);
    const availableWidth = Math.max(0, width - iconWidth - 3);
    const toast = this.toast;
    const statusHint = this.status?.statusHint?.trim();
    const goalStatus = this.iconIntervalId && this.status?.pursuingGoal ? "pursuing goal" : "";
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
