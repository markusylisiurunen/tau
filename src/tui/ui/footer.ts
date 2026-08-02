import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { truncateFromEndByWidth } from "./components/one_line_segments.js";
import type { SystemMessageKind } from "./system_message.js";
import type { Theme } from "./theme/index.js";

export interface FooterStatus {
  contextUsage: string;
  sessionCost: string;
  duration?: string;
  commandHint?: string;
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
    const goalText = this.iconIntervalId && this.status?.pursuingGoal ? "pursuing goal" : "";
    const goalPrefix = goalText ? `${activityStyle(goalText)} ${palette.textDim("·")} ` : "";
    const goalPrefixWidth = goalText ? visibleWidth(goalText) + 3 : 0;

    const leftFull = this.status
      ? `${this.status.duration ? `${this.status.duration} · ` : ""}${this.status.contextUsage} · ${this.status.sessionCost}`
      : "";
    const toast = this.toast;
    const commandHint = this.status?.commandHint?.trim();
    const leftRaw = toast ? toast.text : commandHint || leftFull;
    const leftStyle = toast ? this.getToastStyle(toast.kind) : palette.textDim;
    const availableWidth = Math.max(0, width - iconWidth - goalPrefixWidth - 3);
    const left = truncateFromEndByWidth(leftRaw, availableWidth);
    const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(left)));

    return [` ${icon} ${goalPrefix}${leftStyle(left)}${padding} `];
  }

  private getToastStyle(kind: SystemMessageKind): (text: string) => string {
    const { palette } = this.theme;
    if (kind === "error") return palette.toastError;
    if (kind === "warn") return palette.toastWarn;
    if (kind === "muted") return palette.textMuted;
    return palette.toastSuccess;
  }
}
