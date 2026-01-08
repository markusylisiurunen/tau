import { type Component, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import type { RiskLevel } from "../types.js";
import { truncateFromEndByWidth } from "./components/one_line_segments.js";
import type { Theme } from "./theme.js";

export interface FooterStatus {
  cwd: string;
  contextUsage: string;
  sessionCost: string;
  personaLabel: string;
  reasoningLabel: string;
  riskLevel: RiskLevel;
}

export class FooterComponent implements Component {
  private ui: TUI;
  private theme: Theme;

  private idleIcon = "○";
  private iconFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentIconFrame = 0;
  private iconIntervalId: ReturnType<typeof setInterval> | null = null;

  private status: FooterStatus | null = null;

  constructor(theme: Theme, ui: TUI) {
    this.theme = theme;
    this.ui = ui;
  }

  startWorkingIcon() {
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

  invalidate() {}

  render(width: number) {
    if (width <= 0) return [""];

    const { palette } = this.theme;
    const iconChar = this.iconIntervalId ? this.iconFrames[this.currentIconFrame]! : this.idleIcon;
    const icon = this.iconIntervalId ? palette.accent(iconChar) : palette.dim(iconChar);
    const iconWidth = visibleWidth(iconChar);

    const fullCwd = this.status?.cwd ?? "";
    const compactCwd = this.compactCwd(fullCwd);
    const leftFull = this.status
      ? `${fullCwd} · ${this.status.contextUsage} · ${this.status.sessionCost}`
      : "";
    const leftCompact = this.status
      ? `${compactCwd} · ${this.status.contextUsage} · ${this.status.sessionCost}`
      : "";
    const rightPrefixRaw = this.status
      ? `${this.status.personaLabel} · ${this.status.reasoningLabel} · `
      : "";
    const { riskText, riskStyled } = this.status
      ? this.formatRiskLabel(this.status.riskLevel)
      : { riskText: "", riskStyled: "" };

    const rightWidth = visibleWidth(`${rightPrefixRaw}${riskText}`);
    const fits = (leftValue: string) =>
      1 + iconWidth + 1 + visibleWidth(leftValue) + rightWidth + 1 + 1 <= width;
    const leftRaw = fits(leftFull) ? leftFull : leftCompact;
    const leftWidth = visibleWidth(leftRaw);

    let line: string;

    const totalContentWidth = 1 + iconWidth + 1 + leftWidth + rightWidth + 1 + 1;

    if (totalContentWidth > width) {
      const availableLeft = Math.max(0, width - 1 - iconWidth - 1 - rightWidth - 1 - 1);
      const truncatedLeft = truncateFromEndByWidth(leftRaw, availableLeft);
      const leftStyled = palette.dim(truncatedLeft);
      const rightStyled = `${palette.dim(rightPrefixRaw)}${riskStyled}`;

      line = ` ${icon} ${leftStyled} ${rightStyled} `;
    } else {
      const spaces = " ".repeat(
        Math.max(1, width - 1 - iconWidth - 1 - leftWidth - rightWidth - 1),
      );

      const leftStyled = palette.dim(leftRaw);
      const rightStyled = `${palette.dim(rightPrefixRaw)}${riskStyled}`;
      line = ` ${icon} ${leftStyled + spaces}${rightStyled} `;
    }

    return [line];
  }

  private compactCwd(cwd: string): string {
    if (!cwd) return "";
    if (cwd === "~") return "~";
    const trimmed = cwd.replace(/[\\/]+$/, "");
    if (trimmed === "") return cwd;
    if (trimmed === "~") return "~";
    if (trimmed === "/") return "/";
    const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (lastSlash === -1) return trimmed;
    const base = trimmed.slice(lastSlash + 1);
    return base || trimmed;
  }

  private formatRiskLabel(riskLevel: RiskLevel): { riskText: string; riskStyled: string } {
    const { palette } = this.theme;
    switch (riskLevel) {
      case "restricted":
        return { riskText: "restricted", riskStyled: palette.riskRestricted("restricted") };
      case "read-only":
        return { riskText: "read-only", riskStyled: palette.riskReadOnly("read-only") };
      case "read-write":
        return { riskText: "read-write", riskStyled: palette.riskReadWrite("read-write") };
    }
  }
}
