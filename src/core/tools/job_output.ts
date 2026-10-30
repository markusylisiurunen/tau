import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { CodeModeOutput } from "../../code_mode/output.js";
import { formatBytes, truncateForTokens } from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { writeOutputFile } from "./output_file.js";

export class JobOutput {
  readonly capture: CodeModeOutput;
  private path?: string;
  private finished = false;

  constructor(
    private readonly backend: ToolExecutionBackend,
    private readonly maxCaptureBytes: number,
  ) {
    this.capture = new CodeModeOutput(maxCaptureBytes);
  }

  async finish(): Promise<void> {
    this.path = await writeOutputFile(this.backend, this.capture.text);
    this.finished = true;
  }

  format(maxTokens: number) {
    const text = this.capture.text;
    const projection = truncateForTokens(text, { maxTokens, strategy: "middle" });
    return {
      projection,
      metadata: [
        ...(projection.truncated ? ["output: truncated; showing beginning and end"] : []),
        ...(this.capture.truncated
          ? [
              `capture: truncated; earlier text was discarded (${formatBytes(this.maxCaptureBytes)} limit)`,
            ]
          : []),
        ...(this.path
          ? [`text_log: ${this.path}`]
          : this.finished && text
            ? ["text_log: unavailable"]
            : []),
      ],
      truncated: projection.truncated || this.capture.truncated,
    };
  }

  project(maxTokens: number): {
    metadata: string[];
    content: Array<TextContent | ImageContent>;
    truncated: boolean;
  } {
    const { projection, metadata, truncated } = this.format(maxTokens);
    return {
      metadata,
      content: this.capture.project({
        terminationNote: "",
        projection,
        footer: "",
      }),
      truncated,
    };
  }
}
