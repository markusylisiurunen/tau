import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { CodeModeOutput } from "../../code_mode/output.js";
import { truncateForTokens } from "../utils/truncate.js";
import { writeBashTempFile } from "./bash.js";
import type { ToolExecutionBackend } from "./execution_backend.js";

export class JobOutput {
  readonly capture = new CodeModeOutput();
  private path?: string;
  private savedText?: string;
  private saving = Promise.resolve();

  constructor(private readonly backend: ToolExecutionBackend) {}

  async save(): Promise<string | undefined> {
    const text = this.capture.text;
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        if (text === this.savedText) return;
        if (this.path) await this.backend.writeFile(this.path, text);
        else this.path = await writeBashTempFile(this.backend, text);
        if (this.path) this.savedText = text;
      });
    try {
      await this.saving;
      return this.path;
    } catch {
      return undefined;
    }
  }

  async project(maxTokens: number): Promise<{
    metadata: string[];
    content: Array<TextContent | ImageContent>;
    truncated: boolean;
  }> {
    const text = this.capture.text;
    const projection = truncateForTokens(text, { maxTokens, strategy: "tail" });
    const content = this.capture.project({
      terminationNote: "",
      projection,
      footer: "",
      strategy: "tail",
    });
    const captureTruncated = this.capture.truncated;
    const path = await this.save();
    return {
      metadata: [
        ...(projection.truncated ? ["output: truncated; showing latest output"] : []),
        ...(captureTruncated
          ? ["capture: truncated; earlier text was discarded (1 MiB limit)"]
          : []),
        ...(path ? [`text_log: ${path}`] : text ? ["text_log: unavailable"] : []),
      ],
      content,
      truncated: projection.truncated || captureTruncated,
    };
  }
}
