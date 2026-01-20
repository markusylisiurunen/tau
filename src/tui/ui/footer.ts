import { type Component, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import type { RiskLevel } from "../../core/types.js";
import { truncateFromEndByWidth } from "./components/one_line_segments.js";
import type { SystemMessageKind } from "./system_message.js";
import type { Theme } from "./theme/index.js";

export interface FooterStatus {
  contextUsage: string;
  sessionCost: string;
  riskLevel: RiskLevel;
  duration?: string;
  sandboxed?: boolean;
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
    this.ui.requestRender();
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
    const icon = this.iconIntervalId ? palette.brandAccent(iconChar) : palette.textDim(iconChar);
    const iconWidth = visibleWidth(iconChar);

    const leftFull = this.status
      ? `${this.status.duration ? `${this.status.duration} · ` : ""}${this.status.contextUsage} · ${this.status.sessionCost}`
      : "";
    const toast = this.toast;
    const leftRaw = toast ? toast.text : leftFull;
    const leftStyle = toast ? this.getToastStyle(toast.kind) : palette.textDim;
    const rightPrefixRaw = "";
    const { riskText, riskStyled } = this.status
      ? this.formatRiskLabel(this.status.riskLevel, this.status.sandboxed ?? false)
      : { riskText: "", riskStyled: "" };

    const rightWidth = visibleWidth(`${rightPrefixRaw}${riskText}`);
    const leftWidth = visibleWidth(leftRaw);

    let line: string;

    const totalContentWidth = 1 + iconWidth + 1 + leftWidth + rightWidth + 1 + 1;

    if (totalContentWidth > width) {
      const availableLeft = Math.max(0, width - 1 - iconWidth - 1 - rightWidth - 1 - 1);
      const truncatedLeft = truncateFromEndByWidth(leftRaw, availableLeft);
      const leftStyled = leftStyle(truncatedLeft);
      const rightStyled = `${palette.textDim(rightPrefixRaw)}${riskStyled}`;

      line = ` ${icon} ${leftStyled} ${rightStyled} `;
    } else {
      const spaces = " ".repeat(
        Math.max(1, width - 1 - iconWidth - 1 - leftWidth - rightWidth - 1),
      );

      const leftStyled = leftStyle(leftRaw);
      const rightStyled = `${palette.textDim(rightPrefixRaw)}${riskStyled}`;
      line = ` ${icon} ${leftStyled + spaces}${rightStyled} `;
    }

    return [line];
  }

  private getToastStyle(kind: SystemMessageKind): (text: string) => string {
    const { palette } = this.theme;
    if (kind === "error") return palette.toastError;
    if (kind === "warn") return palette.toastWarn;
    if (kind === "muted") return palette.textMuted;
    return palette.toastSuccess;
  }

  private formatRiskLabel(
    riskLevel: RiskLevel,
    sandboxed: boolean,
  ): { riskText: string; riskStyled: string } {
    const { palette } = this.theme;
    const wrap = (text: string) => (sandboxed ? `[${text}]` : text);
    switch (riskLevel) {
      case "read-only":
        return {
          riskText: wrap("read-only"),
          riskStyled: palette.riskReadOnlyText(wrap("read-only")),
        };
      case "read-write":
        return {
          riskText: wrap("read-write"),
          riskStyled: palette.riskReadWriteText(wrap("read-write")),
        };
    }
  }
}
