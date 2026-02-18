type EditorAdapter = {
  getEditorText: () => string;
  setEditorText: (text: string) => void;
};

export type QueueDrainAdapter = {
  isStreaming: () => boolean;
  onUserInput: (text: string) => Promise<void>;
  requestRender: () => void;
  sendTerminalNotification: (title: string) => void;
  buildIdleNotificationTitle: () => string;
};

export class QueuedUserMessages {
  private readonly messages: string[];
  private isDraining = false;
  private pendingIdleNotification = false;

  constructor(messages: string[]) {
    this.messages = messages;
  }

  enqueue(text: string, requestRender: () => void): void {
    this.messages.push(text);
    requestRender();
  }

  popIntoEditor(editor: EditorAdapter): void {
    if (editor.getEditorText() !== "") return;

    const last = this.messages.pop();
    if (!last) return;

    editor.setEditorText(last);
  }

  dequeueIntoEditor(editor: EditorAdapter): void {
    if (this.messages.length === 0) return;

    const editorText = editor.getEditorText();
    const parts: string[] = [];

    if (editorText !== "") {
      parts.push(editorText);
    }

    parts.push(...this.messages);
    this.messages.length = 0;
    editor.setEditorText(parts.join("\n\n---\n\n"));
  }

  markPendingIdleNotification(): void {
    this.pendingIdleNotification = true;
  }

  async drain(adapter: QueueDrainAdapter): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    try {
      while (!adapter.isStreaming() && this.messages.length > 0) {
        const next = this.messages.shift();
        if (!next) return;

        adapter.requestRender();
        await adapter.onUserInput(next);
      }
    } finally {
      this.isDraining = false;

      if (this.pendingIdleNotification && !adapter.isStreaming() && this.messages.length === 0) {
        this.pendingIdleNotification = false;
        adapter.sendTerminalNotification(adapter.buildIdleNotificationTitle());
      }
    }
  }
}
