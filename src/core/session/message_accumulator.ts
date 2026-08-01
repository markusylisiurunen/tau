import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";

export type AssistantPartialSnapshot = {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  hasTextStarted: boolean;
  hasAnyThinking: boolean;
};

export class MessageAccumulator {
  private text = "";
  private thinkingBlocks: string[] = [];
  private thinkingCurrent = "";
  private toolCalls: ToolCall[] = [];
  private hasTextStarted = false;

  processEvent(event: AssistantMessageEvent): void {
    switch (event.type) {
      case "text_delta": {
        this.text += event.delta;
        if (!this.hasTextStarted && this.text.trim()) {
          this.hasTextStarted = true;
        }
        return;
      }

      case "text_end": {
        this.text = event.content;
        if (!this.hasTextStarted && this.text.trim()) {
          this.hasTextStarted = true;
        }
        return;
      }

      case "thinking_start": {
        this.thinkingCurrent = "";
        return;
      }

      case "thinking_delta": {
        this.thinkingCurrent += event.delta;
        return;
      }

      case "thinking_end": {
        const full = event.content?.trim() ? event.content : this.thinkingCurrent;
        if (full.trim()) {
          this.thinkingBlocks.push(full);
        }
        this.thinkingCurrent = "";
        return;
      }

      case "toolcall_end": {
        this.toolCalls.push(event.toolCall);
        return;
      }

      default:
        return;
    }
  }

  get snapshot(): AssistantPartialSnapshot {
    const thinking = [...this.thinkingBlocks, this.thinkingCurrent]
      .filter((s) => s.trim())
      .join("\n\n");

    return {
      text: this.text,
      thinking,
      toolCalls: [...this.toolCalls],
      hasTextStarted: this.hasTextStarted,
      hasAnyThinking: Boolean(thinking.trim()),
    };
  }
}
