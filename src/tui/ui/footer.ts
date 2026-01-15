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
    if (this.toast) {
      return [this.renderToastLine(width, this.toast.text, this.toast.kind)];
    }

    const { palette } = this.theme;
    const iconChar = this.iconIntervalId ? this.iconFrames[this.currentIconFrame]! : this.idleIcon;
    const icon = this.iconIntervalId ? palette.brandAccent(iconChar) : palette.textDim(iconChar);
    const iconWidth = visibleWidth(iconChar);

    const leftFull = this.status
      ? `${this.status.duration ? `${this.status.duration} · ` : ""}${this.status.contextUsage} · ${this.status.sessionCost}`
      : "";
    const rightPrefixRaw = "";
    const { riskText, riskStyled } = this.status
      ? this.formatRiskLabel(this.status.riskLevel)
      : { riskText: "", riskStyled: "" };

    const rightWidth = visibleWidth(`${rightPrefixRaw}${riskText}`);
    const leftRaw = leftFull;
    const leftWidth = visibleWidth(leftRaw);

    let line: string;

    const totalContentWidth = 1 + iconWidth + 1 + leftWidth + rightWidth + 1 + 1;

    if (totalContentWidth > width) {
      const availableLeft = Math.max(0, width - 1 - iconWidth - 1 - rightWidth - 1 - 1);
      const truncatedLeft = truncateFromEndByWidth(leftRaw, availableLeft);
      const leftStyled = palette.textDim(truncatedLeft);
      const rightStyled = `${palette.textDim(rightPrefixRaw)}${riskStyled}`;

      line = ` ${icon} ${leftStyled} ${rightStyled} `;
    } else {
      const spaces = " ".repeat(
        Math.max(1, width - 1 - iconWidth - 1 - leftWidth - rightWidth - 1),
      );

      const leftStyled = palette.textDim(leftRaw);
      const rightStyled = `${palette.textDim(rightPrefixRaw)}${riskStyled}`;
      line = ` ${icon} ${leftStyled + spaces}${rightStyled} `;
    }

    return [line];
  }

  private renderToastLine(width: number, text: string, kind: SystemMessageKind): string {
    const { palette } = this.theme;
    const style =
      kind === "error"
        ? palette.toastErrorBg
        : kind === "warn"
          ? palette.toastWarnBg
          : kind === "muted"
            ? palette.toastMutedBg
            : palette.toastSuccessBg;

    if (width <= 1) {
      return style(" ".repeat(Math.max(0, width)));
    }

    const innerWidth = Math.max(0, width - 2);
    const trimmed = truncateFromEndByWidth(text, innerWidth);
    const padded = `${trimmed}${" ".repeat(Math.max(0, innerWidth - visibleWidth(trimmed)))}`;
    return style(` ${padded} `);
  }

  private formatRiskLabel(riskLevel: RiskLevel): { riskText: string; riskStyled: string } {
    const { palette } = this.theme;
    switch (riskLevel) {
      case "restricted":
        return { riskText: "restricted", riskStyled: palette.riskRestrictedText("restricted") };
      case "read-only":
        return { riskText: "read-only", riskStyled: palette.riskReadOnlyText("read-only") };
      case "read-write":
        return { riskText: "read-write", riskStyled: palette.riskReadWriteText("read-write") };
    }
  }
}
