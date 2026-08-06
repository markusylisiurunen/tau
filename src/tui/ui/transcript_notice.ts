import { Container, Text } from "@earendil-works/pi-tui";
import type { SessionProtocolFeedbackTone } from "../../protocol/session_protocol.js";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export const TRANSCRIPT_NOTICE_CONTENT_MAX_LINES = 7;
export const TRANSCRIPT_NOTICE_CONTENT_MAX_LINE_CHARS = 256;

export type TranscriptNoticeModel = {
  title: string;
  content?: string[];
  tone: SessionProtocolFeedbackTone;
};

export class TranscriptNoticeComponent
  extends Container
  implements UiComponent<TranscriptNoticeModel>
{
  private theme: Theme;

  constructor(theme: Theme, model: TranscriptNoticeModel) {
    super();
    this.theme = theme;
    this.update(model);
  }

  update(model: TranscriptNoticeModel): void {
    const titleStyle =
      model.tone === "error" ? this.theme.palette.feedbackError : this.theme.palette.feedback;
    this.clear();
    this.addChild(new Text(titleStyle(model.title), 1, 0));

    const content = projectTranscriptNoticeContent(model.content ?? []);
    if (content.length > 0) {
      this.addChild(new Text(this.theme.palette.textDim(content.join("\n")), 1, 0));
    }
  }
}

export function projectTranscriptNoticeContent(content: readonly string[]): string[] {
  const lines = content.flatMap((value) =>
    value.replace(/\r\n?/g, "\n").split("\n").flatMap(splitTranscriptNoticeLine),
  );
  if (lines.length <= TRANSCRIPT_NOTICE_CONTENT_MAX_LINES) return lines;

  const headCount = 3;
  const tailCount = 3;
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    `…${omitted} more ${omitted === 1 ? "line" : "lines"}…`,
    ...lines.slice(-tailCount),
  ];
}

function splitTranscriptNoticeLine(line: string): string[] {
  const characters = Array.from(line);
  if (characters.length === 0) return [""];

  const lines: string[] = [];
  for (
    let index = 0;
    index < characters.length;
    index += TRANSCRIPT_NOTICE_CONTENT_MAX_LINE_CHARS
  ) {
    lines.push(characters.slice(index, index + TRANSCRIPT_NOTICE_CONTENT_MAX_LINE_CHARS).join(""));
  }
  return lines;
}
