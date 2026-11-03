import type { TauSdkHostDiagnostic } from "../sdk/types.js";
import type { SessionChatController } from "./session_chat_controller.js";

type HostDiagnosticTarget = Pick<
  SessionChatController,
  "showHistoryDiagnostic" | "showSessionConfigWarnings"
>;

/**
 * Delivers diagnostics from an in-process host to the TUI. The host can report them before the
 * controller exists, and stderr is not an option once the TUI owns the terminal.
 */
export class HostDiagnosticRelay {
  private target?: HostDiagnosticTarget;
  private readonly pending: TauSdkHostDiagnostic[] = [];
  private readonly shownWarnings = new Set<string>();

  /** `printed` holds warnings the user already saw on stderr before the TUI started. */
  constructor(printed: { cwd: string; warnings: string[] }) {
    this.takeUnseenWarnings(printed.cwd, printed.warnings);
  }

  report(diagnostic: TauSdkHostDiagnostic): void {
    if (!this.target) {
      this.pending.push(diagnostic);
      return;
    }
    this.deliver(this.target, diagnostic);
  }

  attach(target: HostDiagnosticTarget): void {
    this.target = target;
    for (const diagnostic of this.pending.splice(0)) this.deliver(target, diagnostic);
  }

  private deliver(target: HostDiagnosticTarget, diagnostic: TauSdkHostDiagnostic): void {
    if (diagnostic.event !== "session_config_warnings") {
      target.showHistoryDiagnostic(diagnostic);
      return;
    }
    const warnings = this.takeUnseenWarnings(diagnostic.cwd, diagnostic.warnings);
    if (warnings.length > 0) target.showSessionConfigWarnings({ cwd: diagnostic.cwd, warnings });
  }

  private takeUnseenWarnings(cwd: string, warnings: string[]): string[] {
    return warnings.filter((warning) => {
      const key = JSON.stringify([cwd, warning]);
      if (this.shownWarnings.has(key)) return false;
      this.shownWarnings.add(key);
      return true;
    });
  }
}
