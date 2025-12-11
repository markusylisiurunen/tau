import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  type AssistantMessage,
  type Context,
  type Message,
  type ReasoningEffort,
  streamSimple,
  type UserMessage,
} from "@mariozechner/pi-ai";
import { Container, Loader, ProcessTerminal, Spacer, Text, TUI } from "@mariozechner/pi-tui";
import { copyTextToClipboard } from "./clipboard.js";
import { getPersonaById } from "./personas.js";
import type { PromptTemplate } from "./prompts.js";
import type { Persona } from "./types.js";
import { AssistantMessageComponent } from "./ui/assistant_message.js";
import { BashExecutionComponent } from "./ui/bash_execution.js";
import { CustomEditor } from "./ui/custom_editor.js";
import { FooterComponent } from "./ui/footer.js";
import { SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";
import { SystemMessageComponent } from "./ui/system_message.js";
import { theme } from "./ui/theme.js";
import { UserMessageComponent } from "./ui/user_message.js";
import {
  BASH_MAX_CAPTURE_BYTES,
  BASH_MAX_CONTEXT_BYTES_EFFECTIVE,
  BASH_MAX_CONTEXT_LINES,
  BASH_MAX_DISPLAY_BYTES,
  BASH_MAX_DISPLAY_LINES,
  truncateHead,
} from "./utils/truncate.js";

const { palette } = theme;

export interface ChatAppOptions {
  personas: Persona[];
  prompts?: PromptTemplate[];
  initialPersonaId?: string;
  initialUserMessage?: string;
}

export class ChatApp {
  private ui: TUI;
  private chatContainer: Container;
  private footer: FooterComponent;
  private editor: CustomEditor;

  private personas: Persona[];
  private currentPersona: Persona;
  private prompts: PromptTemplate[];
  private initialUserMessage?: string;

  private messages: Message[] = [];
  private isFirstMessage = true;
  private isStreaming = false;
  private isBashMode = false;

  private reasoningLevels: Array<ReasoningEffort | undefined> = [
    undefined,
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];

  constructor(options: ChatAppOptions) {
    this.personas = options.personas;
    this.prompts = options.prompts ?? [];
    this.initialUserMessage = options.initialUserMessage;
    this.currentPersona =
      (options.initialPersonaId && getPersonaById(options.initialPersonaId)) || this.personas[0]!;

    this.ui = new TUI(new ProcessTerminal());
    this.chatContainer = new Container();

    const headerText =
      `${palette.accent("tau")} ${palette.muted("– terminal chat")}\n` +
      palette.muted("Type /help for commands. Enter to send. Ctrl+C to exit.");
    const header = new Text(headerText, 1, 0);

    this.footer = new FooterComponent();
    this.updateFooter();

    this.editor = new CustomEditor(theme.editorTheme);
    this.editor.onCtrlC = () => {
      this.stop();
      process.exit(0);
    };
    this.editor.onShiftTab = () => this.cycleReasoningLevel();

    this.editor.onChange = (text: string) => {
      const wasBash = this.isBashMode;
      this.isBashMode = text.trimStart().startsWith("!");
      if (wasBash !== this.isBashMode) {
        this.updateEditorBorderColor();
      }
    };

    this.editor.setAutocompleteProvider(
      new SlashAutocompleteProvider(
        () => this.personas.map((p) => ({ id: p.id, label: p.label })),
        () => this.prompts.map((t) => ({ id: t.id, label: t.label })),
      ),
    );

    this.editor.onSubmit = (text) => this.handleSubmit(text);

    this.ui.addChild(header);
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.editor);
    this.ui.addChild(this.footer);
    this.ui.setFocus(this.editor);

    this.updateEditorBorderColor();
  }

  async start(): Promise<void> {
    this.ui.start();
    this.addSystemMessage(
      `Persona: ${theme.formatPersonaLabel(this.currentPersona.label, this.currentPersona.model.id)}`,
    );

    if (this.initialUserMessage) {
      await this.sendInitialUserMessage(this.initialUserMessage);
    }
  }

  stop(): void {
    this.ui.stop();
  }

  private updateFooter() {
    const reasoningLabel = this.currentPersona.settings.reasoning || "default";

    const contextUsage = this.getContextUsageString();
    const sessionCost = this.getSessionCostString();

    const cwd = formatCwd(process.cwd());
    const left = `${cwd} · ${contextUsage} · ${sessionCost}`;
    const personaName = this.currentPersona.label || this.currentPersona.id;
    const right = `${personaName} · ${this.currentPersona.model.id} (${reasoningLabel})`;

    this.footer.setLeftRight(left, right);
    this.ui.requestRender();
  }

  private addSystemMessage(text: string, styleFn?: (t: string) => string) {
    this.chatContainer.addChild(new SystemMessageComponent(text, this.isFirstMessage, styleFn));
    this.isFirstMessage = false;
    this.ui.requestRender();
  }

  private addUserMessage(text: string) {
    this.chatContainer.addChild(new UserMessageComponent(text, this.isFirstMessage));
    this.isFirstMessage = false;
    this.ui.requestRender();
  }

  private addAssistantComponent(component: AssistantMessageComponent) {
    this.chatContainer.addChild(component);
    this.isFirstMessage = false;
    this.ui.requestRender();
  }

  private async handleSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming) return;

    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }

    if (trimmed.startsWith("!")) {
      const command = trimmed.slice(1).trim();
      if (!command) return;
      await this.runBashCommand(command);
      return;
    }

    this.addUserMessage(trimmed);

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: trimmed }],
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    await this.runAssistantTurn();
  }

  private async sendInitialUserMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming) return;

    this.addUserMessage(trimmed);

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: trimmed }],
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    await this.runAssistantTurn();
  }

  private async handleCommand(raw: string) {
    const trimmed = raw.trim();

    if (trimmed === "/help") {
      const promptIds = this.prompts.map((p) => p.id).join(", ");
      this.addSystemMessage(
        [
          "Commands:",
          "/help           Show this help",
          "/copy           Copy last assistant message",
          "/persona:<id>   Switch persona",
          "/prompt:<id>    Insert a prompt template",
          "/new            Clear session",
          ...(promptIds ? ["", `Available prompts: ${promptIds}`] : []),
        ].join("\n"),
      );
      return;
    }

    if (trimmed === "/copy") {
      const lastAssistant = [...this.messages].reverse().find((m) => m.role === "assistant") as
        | AssistantMessage
        | undefined;
      if (!lastAssistant) {
        this.addSystemMessage("No assistant message to copy yet.");
        return;
      }
      const text = extractAssistantText(lastAssistant);
      if (!text.trim()) {
        this.addSystemMessage("Last assistant message was empty.");
        return;
      }
      try {
        await copyTextToClipboard(text);
        this.addSystemMessage("Copied last assistant message to clipboard.", palette.success);
      } catch (err) {
        this.addSystemMessage(`Clipboard copy failed: ${(err as Error).message}`, palette.error);
      }
      return;
    }

    if (trimmed === "/new") {
      this.messages = [];
      this.chatContainer.clear();
      this.isFirstMessage = true;
      this.isBashMode = false;
      this.updateEditorBorderColor();
      this.updateFooter();
      this.ui.requestRender();
      return;
    }

    const personaMatch = trimmed.match(/^\/persona:(.+)$/i);
    if (personaMatch) {
      const id = personaMatch[1]?.trim() ?? "";
      if (!id) {
        this.addSystemMessage("Usage: /persona:<id>");
        return;
      }
      const persona =
        getPersonaById(id) ?? this.personas.find((p) => p.id.toLowerCase() === id.toLowerCase());
      if (!persona) {
        this.addSystemMessage(`Unknown persona '${id}'.`);
        return;
      }
      this.currentPersona = persona;
      this.updateFooter();
      this.addSystemMessage(
        `Switched to ${theme.formatPersonaLabel(persona.label, persona.model.id)}`,
      );
      return;
    }

    const promptMatch = trimmed.match(/^\/prompt:(.+)$/i);
    if (promptMatch) {
      const idRaw = promptMatch[1]?.trim() ?? "";
      if (!idRaw) {
        this.addSystemMessage("Usage: /prompt:<id>");
        return;
      }
      const lower = idRaw.toLowerCase();
      const prompt = this.prompts.find((p) => p.id.toLowerCase() === lower);
      if (!prompt) {
        this.addSystemMessage(`Unknown prompt '${idRaw}'.`);
        return;
      }
      this.editor.setText(prompt.template);
      this.ui.requestRender();
      return;
    }

    this.addSystemMessage("Unknown command. Type /help.");
  }

  private async runAssistantTurn() {
    this.isStreaming = true;
    this.editor.disableSubmit = true;

    const assistantComponent = new AssistantMessageComponent();
    assistantComponent.setHideThinking(true);
    const loader = new Loader(this.ui, palette.accent, palette.muted, "Thinking...");
    this.chatContainer.addChild(loader);
    this.ui.requestRender();

    try {
      const context: Context = {
        systemPrompt: this.currentPersona.systemPrompt,
        messages: this.messages,
      };

      const stream = streamSimple(this.currentPersona.model, context, this.currentPersona.settings);

      let text = "";
      let hasTextStarted = false;
      let thinkingDoneInserted = false;

      const insertThinkingDone = () => {
        if (thinkingDoneInserted) return;
        thinkingDoneInserted = true;
        this.addSystemMessage("Thinking done.", palette.muted);
      };

      for await (const event of stream) {
        if (event.type === "text_delta") {
          text += event.delta;
        }

        if (!hasTextStarted && text.trim()) {
          hasTextStarted = true;
          this.chatContainer.removeChild(loader);
          loader.stop();
          insertThinkingDone();
          this.addAssistantComponent(assistantComponent);
        }

        if (hasTextStarted) {
          assistantComponent.updatePartial(text);
          this.ui.requestRender();
        }
      }

      const finalMessage = await stream.result();
      this.messages.push(finalMessage);
      this.updateFooter();

      if (!hasTextStarted) {
        this.chatContainer.removeChild(loader);
        loader.stop();
        insertThinkingDone();
        this.addAssistantComponent(assistantComponent);
      }

      assistantComponent.updateFromMessage(finalMessage);
      this.ui.requestRender();
    } catch (err) {
      this.chatContainer.removeChild(loader);
      loader.stop();
      this.addSystemMessage(`Error: ${(err as Error).message}`, palette.error);
    } finally {
      // Ensure loader is stopped even if we errored early.
      this.chatContainer.removeChild(loader);
      loader.stop();
      this.isStreaming = false;
      this.editor.disableSubmit = false;
      this.ui.requestRender();
    }
  }

  private cycleReasoningLevel() {
    const current = this.currentPersona.settings.reasoning;
    const index = this.reasoningLevels.indexOf(current);
    const next = this.reasoningLevels[(index + 1) % this.reasoningLevels.length];
    this.currentPersona.settings.reasoning = next;
    this.updateFooter();
  }

  private getLastAssistantMessage(): AssistantMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m?.role === "assistant") return m as AssistantMessage;
    }
    return undefined;
  }

  private getContextWindowForLastTurn(last: AssistantMessage): number {
    // Prefer exact matching persona model, otherwise fall back to current persona.
    const exactPersona = this.personas.find(
      (p) => p.model.provider === last.provider && p.model.id === last.model,
    );
    return exactPersona?.model.contextWindow ?? this.currentPersona.model.contextWindow;
  }

  private getContextUsageString(): string {
    const last = this.getLastAssistantMessage();
    const windowTokens = last
      ? this.getContextWindowForLastTurn(last)
      : this.currentPersona.model.contextWindow;

    if (!last) {
      const { read, write } = this.getCacheTotals();
      return `R${formatTokenWindow(read)} W${formatTokenWindow(write)} 0%/${formatTokenWindow(windowTokens)}`;
    }

    const inputTokens = last.usage?.input ?? 0;
    const percent = windowTokens > 0 ? (inputTokens / windowTokens) * 100 : 0;
    const percentStr = `${formatAdaptiveNumber(percent, 1, 3)}%`;
    const { read, write } = this.getCacheTotals();
    return `R${formatTokenWindow(read)} W${formatTokenWindow(write)} ${percentStr}/${formatTokenWindow(windowTokens)}`;
  }

  private getSessionCostString(): string {
    let total = 0;
    for (const m of this.messages) {
      if (m.role === "assistant") {
        const a = m as AssistantMessage;
        total += a.usage?.cost?.total ?? 0;
      }
    }
    return `$${formatAdaptiveNumber(total, 2, 5)}`;
  }

  private getCacheTotals(): { read: number; write: number } {
    let read = 0;
    let write = 0;
    for (const m of this.messages) {
      if (m.role === "assistant") {
        const usage = (m as AssistantMessage).usage;
        read += usage?.cacheRead ?? 0;
        write += usage?.cacheWrite ?? 0;
      }
    }
    return { read, write };
  }

  private updateEditorBorderColor(): void {
    if (this.isBashMode) {
      this.editor.borderColor = (s: string) => palette.bash(s);
    } else {
      this.editor.borderColor = (s: string) => palette.border(s);
    }
    this.ui.requestRender();
  }

  private async runBashCommand(command: string): Promise<void> {
    this.isStreaming = true;
    this.editor.disableSubmit = true;

    try {
      const { output, exitCode, truncated: captureTruncated } = await executeShellCommand(command);

      const contextTruncation = truncateHead(output, {
        maxLines: BASH_MAX_CONTEXT_LINES,
        maxBytes: BASH_MAX_CONTEXT_BYTES_EFFECTIVE,
      });

      const displayTruncation = truncateHead(contextTruncation.content, {
        maxLines: BASH_MAX_DISPLAY_LINES,
        maxBytes: BASH_MAX_DISPLAY_BYTES,
      });

      const modelTruncated = contextTruncation.truncated || captureTruncated;
      const bashComponent = new BashExecutionComponent(
        command,
        displayTruncation.content,
        exitCode,
        displayTruncation,
        captureTruncated,
        modelTruncated ? contextTruncation : undefined,
        captureTruncated,
      );
      this.chatContainer.addChild(bashComponent);
      this.isFirstMessage = false;

      // Store in context for follow-up questions.
      const outputForContext = contextTruncation.content.trimEnd() || "(no output)";
      const truncNote =
        contextTruncation.truncated || captureTruncated
          ? `\n\n[output truncated for context: first ${contextTruncation.outputLines} lines / ${contextTruncation.outputBytes} bytes]`
          : "";
      const bashContextText = `$ ${command}\n${outputForContext}${truncNote}`;
      this.messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Bash command output:\n${bashContextText}`,
          },
        ],
        timestamp: Date.now(),
      });

      this.ui.requestRender();
    } catch (err) {
      this.addSystemMessage(`Bash error: ${(err as Error).message}`, palette.error);
    } finally {
      this.isStreaming = false;
      this.editor.disableSubmit = false;
      this.ui.requestRender();
    }
  }
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function formatTokenWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m.toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k.toFixed(tokens % 1_000 === 0 ? 0 : 1)}k`;
  }
  return String(tokens);
}

/**
 * Format a number with adaptive precision for tiny values.
 * Starts at `minDecimals` and increases until the formatted value is non-zero
 * (or maxDecimals reached). Intended for percent/cost display in footer.
 */
function formatAdaptiveNumber(value: number, minDecimals: number, maxDecimals: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return value.toFixed(minDecimals);

  let decimals = minDecimals;
  let formatted = value.toFixed(decimals);

  while (decimals < maxDecimals && Number(formatted) === 0) {
    decimals += 1;
    formatted = value.toFixed(decimals);
  }

  return formatted;
}

function executeShellCommand(
  command: string,
): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let output = "";
    let truncated = false;

    const append = (chunk: string) => {
      if (!chunk) return;
      output += chunk;
      if (Buffer.byteLength(output, "utf-8") > BASH_MAX_CAPTURE_BYTES) {
        truncated = true;
        output = truncateToBytesFromStart(output, BASH_MAX_CAPTURE_BYTES);
      }
    };

    child.stdout?.on("data", (d) => append(d.toString()));
    child.stderr?.on("data", (d) => append(d.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ output, exitCode: code, truncated });
    });
  });
}

function truncateToBytesFromStart(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;

  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.slice(0, end).toString("utf-8");
}

function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}
