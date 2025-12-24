import type { AssistantStreamEvent } from "@markusylisiurunen/iota";

export type AssistantPartialSnapshot = {
  text: string;
  thinking: string;
  hasTextStarted: boolean;
  hasAnyThinking: boolean;
};

function hasPartial(
  event: AssistantStreamEvent,
): event is Extract<AssistantStreamEvent, { partial: unknown }> {
  return "partial" in event;
}

export class MessageAccumulator {
  private text = "";
  private thinking = "";
  private hasTextStarted = false;

  processEvent(event: AssistantStreamEvent): boolean {
    if (!hasPartial(event)) {
      return false;
    }

    const partial = event.partial;

    const nextText = partial.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    const nextThinking = partial.content
      .filter((p) => p.type === "thinking")
      .map((p) => p.text)
      .join("\n\n");

    const changed = nextText !== this.text || nextThinking !== this.thinking;

    this.text = nextText;
    this.thinking = nextThinking;

    if (!this.hasTextStarted && this.text.trim()) {
      this.hasTextStarted = true;
    }

    return changed;
  }

  get snapshot(): AssistantPartialSnapshot {
    const thinking = this.thinking.trim();
    return {
      text: this.text,
      thinking,
      hasTextStarted: this.hasTextStarted,
      hasAnyThinking: Boolean(thinking),
    };
  }
}
