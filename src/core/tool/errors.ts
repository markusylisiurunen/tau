export type ToolHelpPrinter = (log?: (line: string) => void) => void;

export class ToolCliError extends Error {
  readonly helpPrinter?: ToolHelpPrinter;

  constructor(message: string, options?: { helpPrinter?: ToolHelpPrinter }) {
    super(message);
    this.name = "ToolCliError";
    this.helpPrinter = options?.helpPrinter;
  }
}
