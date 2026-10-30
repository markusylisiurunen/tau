import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { CodeModeOutput } from "../../code_mode/output.js";
import { truncateForTokens } from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { writeOutputFile } from "./output_file.js";

export class JobOutput {
  readonly capture = new CodeModeOutput();
  private path?: string;
  private savedText?: string;
  private available = false;
  private saving = Promise.resolve();

  constructor(private readonly backend: ToolExecutionBackend) {}

  async save(): Promise<string | undefined> {
    const text = this.capture.text;
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        if (text === this.savedText) return;
        if (this.path) await this.backend.writeFile(this.path, text);
        else this.path = await writeOutputFile(this.backend, text);
        if (this.path) this.savedText = text;
      });
    try {
      await this.saving;
      this.available = this.path !== undefined;
      return this.path;
    } catch {
      this.available = false;
      return undefined;
    }
  }

  format(maxTokens: number) {
    const text = this.capture.text;
    const projection = truncateForTokens(text, { maxTokens, strategy: "tail" });
    return {
      projection,
      metadata: [
        ...(projection.truncated ? ["output: truncated; showing latest output"] : []),
        ...(this.capture.truncated
          ? ["capture: truncated; earlier text was discarded (1 MiB limit)"]
          : []),
        ...(this.available ? [`text_log: ${this.path}`] : text ? ["text_log: unavailable"] : []),
      ],
      truncated: projection.truncated || this.capture.truncated,
    };
  }

  async project(maxTokens: number): Promise<{
    metadata: string[];
    content: Array<TextContent | ImageContent>;
    truncated: boolean;
  }> {
    await this.save();
    const { projection, metadata, truncated } = this.format(maxTokens);
    return {
      metadata,
      content: this.capture.project({
        terminationNote: "",
        projection,
        footer: "",
        strategy: "tail",
      }),
      truncated,
    };
  }
}
