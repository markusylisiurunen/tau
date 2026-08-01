import type { ChatContainerComponent } from "./ui/chat_container.js";
import type { ToolUiModel } from "./ui/tool_ui_model.js";

export class ToolUiRouter {
  private readonly chatContainer: ChatContainerComponent;
  private readonly requestRender: () => void;
  private readonly sessionToolCallIds = new Set<string>();

  constructor(options: { chatContainer: ChatContainerComponent; requestRender: () => void }) {
    this.chatContainer = options.chatContainer;
    this.requestRender = options.requestRender;
  }

  resetSession(): void {
    this.sessionToolCallIds.clear();
  }

  reconcileSession(models: readonly ToolUiModel[]): void {
    const currentIds = new Set(models.map((model) => model.toolCallId));
    const staleIds = [...this.sessionToolCallIds].filter((id) => !currentIds.has(id));
    if (staleIds.length > 0) {
      this.chatContainer.removeMessages(staleIds);
    }

    this.sessionToolCallIds.clear();
    for (const model of models) {
      this.sessionToolCallIds.add(model.toolCallId);
      this.upsertToolMessage(model);
    }
    this.requestRender();
  }

  updateLocal(model: ToolUiModel): void {
    this.upsertToolMessage(model);
    this.requestRender();
  }

  private upsertToolMessage(model: ToolUiModel): void {
    const message = { type: "tool" as const, tool: model };
    if (!this.chatContainer.updateMessage(model.toolCallId, message)) {
      this.chatContainer.addMessage(message, model.toolCallId);
    }
  }
}
