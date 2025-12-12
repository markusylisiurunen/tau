import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  type AssistantMessage,
  type Context,
  type Message,
  type ReasoningEffort,
  streamSimple,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@mariozechner/pi-ai";
import { Container, Loader, Spacer, Text, TUI } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { copyTextToClipboard } from "./clipboard.js";
import { getPersonaById } from "./personas.js";
import type { PromptTemplate } from "./prompts.js";
import { createAppTerminal } from "./terminal.js";
import type { Persona, ToolAccessLevel } from "./types.js";
import { AssistantMessageComponent } from "./ui/assistant_message.js";
import { BashBlockedComponent, BashExecutionComponent } from "./ui/bash_execution.js";
import { CustomEditor } from "./ui/custom_editor.js";
import { FooterComponent } from "./ui/footer.js";
import { SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";
import { SystemMessageComponent } from "./ui/system_message.js";
import { editorBorderForReasoning, theme } from "./ui/theme.js";
import { UserMessageComponent } from "./ui/user_message.js";
import { listProjectFiles } from "./utils/project_files.js";
import {
  BASH_MAX_CAPTURE_BYTES,
  BASH_MAX_CONTEXT_BYTES_EFFECTIVE,
  BASH_MAX_CONTEXT_LINES,
  BASH_MAX_DISPLAY_BYTES,
  BASH_MAX_DISPLAY_LINES,
  truncateHead,
} from "./utils/truncate.js";

const { palette } = theme;

const MAX_ASSISTANT_SUBTURNS = 128;
type BashRisk = "read" | "write";

const BASH_TOOL: Tool = {
  name: "bash",
  description:
    "Execute a shell command in the current working directory and return stdout/stderr. Always provide a risk assessment: 'read' for commands without side effects, 'write' for commands that may mutate state (filesystem, processes, network, etc).",
  parameters: Type.Object(
    {
      command: Type.String({
        description: ["The shell command to execute."].join(" "),
      }),
      risk: Type.String({
        description: [
          "Risk level of the command; MUST be either 'read' or 'write'.",
          "Use 'read' only for non-mutating commands; otherwise use 'write'.",
        ].join(" "),
      }),
    },
    { additionalProperties: false },
  ),
};

export interface ChatAppOptions {
  personas: Persona[];
  prompts?: PromptTemplate[];
  initialPersonaId?: string;
  initialUserMessage?: string;
  initialToolAccessLevel?: ToolAccessLevel;
  noContext?: boolean;
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
  private assistantComponents: AssistantMessageComponent[] = [];
  private isFirstMessage = true;
  private isStreaming = false;
  private isBashMode = false;
  private showThinking = false;
  private currentTurnAbort?: AbortController;
  private toolAccessLevel: ToolAccessLevel = "read";
  private readonly initialToolAccessLevel: ToolAccessLevel;
  private readonly environmentTag: string;
  private readonly projectContextBlock?: string;
  private readonly projectFiles: string[];
  private baseSystemPrompt: string;
  private pendingToolAccessChange?:
    | {
        from: ToolAccessLevel;
        to: ToolAccessLevel;
      }
    | undefined;

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
    if (options.initialToolAccessLevel) {
      this.toolAccessLevel = options.initialToolAccessLevel;
    }
    this.initialToolAccessLevel = this.toolAccessLevel;
    this.environmentTag = buildEnvironmentTag({
      toolAccessLevel: this.initialToolAccessLevel,
      cwd: process.cwd(),
      datetime: new Date().toISOString(),
    });
    this.projectContextBlock = options.noContext
      ? undefined
      : buildProjectContextBlock({
          cwd: process.cwd(),
          home: homedir(),
        });
    this.projectFiles = listProjectFiles(process.cwd());
    this.currentPersona =
      (options.initialPersonaId && getPersonaById(options.initialPersonaId)) || this.personas[0]!;
    this.clampPersonaReasoning(this.currentPersona);
    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
    });

    this.ui = new TUI(createAppTerminal(Boolean(this.initialUserMessage)));
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
    this.editor.onCtrlT = () => this.toggleThinkingVisibility();
    this.editor.onShiftTab = () => this.cycleReasoningLevel();
    this.editor.onEscape = () => this.interruptAssistantTurn();

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
        () => this.projectFiles,
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
    const toolLevel = this.toolAccessLevel;
    const toolLabel =
      toolLevel === "none"
        ? "none"
        : toolLevel === "read"
          ? palette.success("read")
          : palette.error("all");

    const contextUsage = this.getContextUsageString();
    const sessionCost = this.getSessionCostString();

    const cwd = formatCwd(process.cwd());
    const left = `${cwd} · ${contextUsage} · ${sessionCost}`;
    const personaName = this.currentPersona.label || this.currentPersona.id;
    const right = `${personaName} · ${this.currentPersona.model.id} (${reasoningLabel}) · ${toolLabel}`;

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
    this.assistantComponents.push(component);
    this.isFirstMessage = false;
    this.ui.requestRender();
  }

  private toggleThinkingVisibility(): void {
    this.showThinking = !this.showThinking;
    for (const c of this.assistantComponents) {
      c.setHideThinking(!this.showThinking);
    }
    this.addSystemMessage(
      this.showThinking
        ? "Thoughts visible (Ctrl+T to hide)."
        : "Thoughts hidden (Ctrl+T to show).",
      palette.muted,
    );
    this.ui.requestRender();
  }

  private interruptAssistantTurn(): void {
    if (!this.isStreaming) return;
    if (this.currentTurnAbort?.signal.aborted) return;

    this.currentTurnAbort?.abort();
    this.addSystemMessage("Interrupted.", palette.muted);
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

    const systemNotice = this.pendingToolAccessChange
      ? formatToolAccessChangeNotice(this.pendingToolAccessChange)
      : undefined;
    this.pendingToolAccessChange = undefined;
    const textForModel = systemNotice ? `${systemNotice}\n\n${trimmed}` : trimmed;

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: textForModel }],
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
          "/tool:none      Block model bash tool calls",
          "/tool:read      Allow read-only model bash tool",
          "/tool:all       Allow all model bash tool",
          "/new            Clear session",
          "",
          "Keys:",
          "Shift+Tab       Cycle reasoning effort",
          "Ctrl+T          Toggle thoughts visibility",
          "Esc             Interrupt assistant",
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
      this.assistantComponents = [];
      this.chatContainer.clear();
      this.isFirstMessage = true;
      this.isBashMode = false;
      this.updateEditorBorderColor();
      this.updateFooter();
      this.ui.requestRender();
      return;
    }

    const toolMatch = trimmed.match(/^\/tool:(none|read|all)$/i);
    if (toolMatch) {
      const level = toolMatch[1]!.toLowerCase() as ToolAccessLevel;
      const previous = this.toolAccessLevel;
      this.toolAccessLevel = level;
      this.updateFooter();
      if (previous !== level) {
        this.pendingToolAccessChange = { from: previous, to: level };
      }
      const details =
        level === "none"
          ? "bash tool disabled for the model."
          : level === "read"
            ? "model may run read-only bash commands."
            : "model may run all bash commands (including write/side-effecting).";
      this.addSystemMessage(`Tool access set to '${level}': ${details}`, palette.systemLabel);
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
      this.clampPersonaReasoning(this.currentPersona);
      this.baseSystemPrompt = buildBaseSystemPrompt({
        personaSystemPrompt: this.currentPersona.systemPrompt,
        projectContextBlock: this.projectContextBlock,
        environmentTag: this.environmentTag,
      });
      this.updateFooter();
      this.updateEditorBorderColor();
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
    this.currentTurnAbort = new AbortController();

    try {
      let subturns = 0;
      while (subturns < MAX_ASSISTANT_SUBTURNS) {
        if (this.currentTurnAbort.signal.aborted) break;
        subturns += 1;

        const assistantComponent = new AssistantMessageComponent();
        const showThinking = this.showThinking;
        assistantComponent.setHideThinking(!showThinking);
        assistantComponent.setLeadingSpacer(showThinking);
        const loader = showThinking
          ? undefined
          : new Loader(this.ui, palette.accent, palette.muted, "Thinking...");
        let loaderActive = !showThinking;
        const stopLoader = () => {
          if (!loaderActive) return;
          loaderActive = false;
          if (loader) {
            this.chatContainer.removeChild(loader);
            loader.stop();
          }
        };

        if (loader) {
          this.chatContainer.addChild(loader);
          this.ui.requestRender();
        }

        try {
          const personaTools = this.currentPersona.tools ?? [];
          const tools = [BASH_TOOL, ...personaTools.filter((t) => t.name !== BASH_TOOL.name)];

          const context: Context = {
            systemPrompt: this.baseSystemPrompt,
            messages: this.messages,
            tools,
          };

          const stream = streamSimple(this.currentPersona.model, context, {
            ...this.getStreamingSettings(this.currentPersona),
            signal: this.currentTurnAbort.signal,
          });

          let text = "";
          const thinkingBlocks: string[] = [];
          let thinkingCurrent = "";
          let hasTextStarted = false;
          let thinkingDoneInserted = false;
          let assistantInserted = false;

          const insertThinkingDone = () => {
            if (thinkingDoneInserted) return;
            thinkingDoneInserted = true;
            if (showThinking) return;
            this.addSystemMessage("Thinking done.", palette.muted);
            // Always leave exactly one blank line after "Thinking done."
            this.chatContainer.addChild(new Spacer(1));
            this.isFirstMessage = false;
            this.ui.requestRender();
          };

          const ensureAssistantInserted = () => {
            if (assistantInserted) return;
            assistantInserted = true;
            stopLoader();
            this.addAssistantComponent(assistantComponent);
          };

          let finalMessage: AssistantMessage | undefined;
          try {
            for await (const event of stream) {
              if (event.type === "text_delta") {
                text += event.delta;
              }

              if (event.type === "thinking_start") {
                thinkingCurrent = "";
              }
              if (event.type === "thinking_delta") {
                thinkingCurrent += event.delta;
                if (showThinking && thinkingCurrent.trim() && !assistantInserted) {
                  ensureAssistantInserted();
                }
              }
              if (event.type === "thinking_end") {
                const full = event.content?.trim() ? event.content : thinkingCurrent;
                if (full.trim()) thinkingBlocks.push(full);
                thinkingCurrent = "";
                if (showThinking && thinkingBlocks.length > 0 && !assistantInserted) {
                  ensureAssistantInserted();
                }
              }

              if (!hasTextStarted && text.trim()) {
                hasTextStarted = true;
                insertThinkingDone();
                ensureAssistantInserted();
              }

              if (assistantInserted) {
                const thinking = [...thinkingBlocks, thinkingCurrent]
                  .filter((s) => s.trim())
                  .join("\n\n");
                assistantComponent.updatePartial(hasTextStarted ? text : "", thinking);
                this.ui.requestRender();
              }
            }

            finalMessage = await stream.result();
          } catch (err) {
            if (this.currentTurnAbort.signal.aborted) {
              if (assistantInserted) {
                const thinking = [...thinkingBlocks, thinkingCurrent]
                  .filter((s) => s.trim())
                  .join("\n\n");
                assistantComponent.updatePartial(hasTextStarted ? text : "", thinking);
                this.ui.requestRender();
              }
              break;
            }
            throw err;
          }

          this.messages.push(finalMessage);
          this.updateFooter();

          if (!assistantInserted) {
            if (!showThinking) insertThinkingDone();
            ensureAssistantInserted();
          }

          assistantComponent.updateFromMessage(finalMessage);
          this.ui.requestRender();

          if (finalMessage.stopReason !== "toolUse") break;

          const toolCalls = finalMessage.content.filter(
            (c): c is ToolCall => c.type === "toolCall",
          );
          if (!toolCalls.length) break;

          if (this.currentTurnAbort.signal.aborted) break;
          await this.executeToolCalls(toolCalls);
        } finally {
          stopLoader();
        }
      }

      if (subturns >= MAX_ASSISTANT_SUBTURNS) {
        this.addSystemMessage(
          `Stopped after ${MAX_ASSISTANT_SUBTURNS} tool subturns to avoid an infinite loop.`,
          palette.warn,
        );
      }
    } catch (err) {
      this.addSystemMessage(`Error: ${(err as Error).message}`, palette.error);
    } finally {
      this.isStreaming = false;
      this.editor.disableSubmit = false;
      this.currentTurnAbort = undefined;
      this.ui.requestRender();
    }
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
    for (const [index, toolCall] of toolCalls.entries()) {
      if (this.currentTurnAbort?.signal.aborted) {
        return;
      }
      if (toolCall.name !== BASH_TOOL.name) {
        const msg = `Tool '${toolCall.name}' is not supported by tau.`;
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: msg }],
          isError: true,
          timestamp: Date.now(),
        };
        this.messages.push(toolResult);
        this.addSystemMessage(msg, palette.error);
        continue;
      }

      if (this.toolAccessLevel === "none") {
        const msg =
          "bash tool call blocked: tool access is set to 'none'. Ask the user to enable it with /tool:read or /tool:all.";
        const commandForDisplay =
          typeof (toolCall.arguments as { command?: unknown } | undefined)?.command === "string"
            ? String((toolCall.arguments as { command?: unknown }).command).trim() ||
              "(empty command)"
            : "(missing command)";
        this.chatContainer.addChild(new BashBlockedComponent(commandForDisplay, msg, index !== 0));
        this.isFirstMessage = false;
        this.ui.requestRender();
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: msg }],
          isError: true,
          timestamp: Date.now(),
        };
        this.messages.push(toolResult);
        continue;
      }

      const args = toolCall.arguments as { command?: unknown; risk?: unknown } | undefined;
      const commandRaw = args?.command;
      const riskRaw = args?.risk;
      const command = typeof commandRaw === "string" ? commandRaw.trim() : "";
      const risk: BashRisk | undefined =
        riskRaw === "read" || riskRaw === "write" ? (riskRaw as BashRisk) : undefined;

      if (!command || !risk) {
        const msg =
          !command && !risk
            ? "bash tool call missing valid 'command' and 'risk' fields."
            : !command
              ? "bash tool call missing a valid 'command' string."
              : "bash tool call missing a valid 'risk' value ('read' or 'write').";
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: msg }],
          isError: true,
          timestamp: Date.now(),
        };
        this.messages.push(toolResult);
        const commandForDisplay = command || "(missing command)";
        this.chatContainer.addChild(new BashBlockedComponent(commandForDisplay, msg, index !== 0));
        this.isFirstMessage = false;
        this.ui.requestRender();
        continue;
      }

      if (this.toolAccessLevel === "read" && risk === "write") {
        const msg =
          "bash tool call blocked: declared risk 'write' exceeds current tool access 'read'. Ask the user to run /tool:all or revise to a read-only command.";
        this.chatContainer.addChild(new BashBlockedComponent(command, msg, index !== 0));
        this.isFirstMessage = false;
        this.ui.requestRender();
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: msg }],
          isError: true,
          timestamp: Date.now(),
        };
        this.messages.push(toolResult);
        continue;
      }

      try {
        const {
          output,
          exitCode,
          truncated: captureTruncated,
        } = await executeShellCommand(command);

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
          index !== 0,
        );
        this.chatContainer.addChild(bashComponent);
        this.isFirstMessage = false;

        const outputForContext = contextTruncation.content.trimEnd() || "(no output)";
        const truncNote = modelTruncated
          ? `\n\n[output truncated for context: first ${contextTruncation.outputLines} lines / ${contextTruncation.outputBytes} bytes]`
          : "";
        const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
        const toolText = `$ ${command}\n${outputForContext}${truncNote}${exitNote}`;

        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: toolText }],
          isError: exitCode !== null && exitCode !== 0,
          timestamp: Date.now(),
        };
        this.messages.push(toolResult);
        this.ui.requestRender();
      } catch (e) {
        const msg = `bash tool execution failed: ${e instanceof Error ? e.message : String(e)}`;
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: msg }],
          isError: true,
          timestamp: Date.now(),
        };
        this.messages.push(toolResult);
        this.addSystemMessage(msg, palette.error);
      }
    }
  }

  private cycleReasoningLevel() {
    const allowed = this.getAllowedReasoningLevelsForPersona(this.currentPersona);
    const current = this.currentPersona.settings.reasoning;
    const index = allowed.indexOf(current);
    const next = allowed[(index + 1) % allowed.length];
    this.currentPersona.settings.reasoning = next;
    this.updateFooter();
    this.updateEditorBorderColor();
  }

  private getAllowedReasoningLevelsForPersona(
    persona: Persona,
  ): Array<ReasoningEffort | undefined> {
    if (!persona.model.reasoning) {
      return [undefined];
    }

    const raw = persona.allowedReasoningLevels;
    if (!raw || raw.length === 0) {
      return this.reasoningLevels;
    }

    const normalized: Array<ReasoningEffort | undefined> = [];
    for (const level of raw) {
      if (level === "none") {
        normalized.push(undefined);
        continue;
      }
      if (this.reasoningLevels.includes(level as ReasoningEffort)) {
        normalized.push(level as ReasoningEffort);
      }
    }

    const unique = [...new Set(normalized)];
    return unique.length ? unique : this.reasoningLevels;
  }

  private clampPersonaReasoning(persona: Persona): void {
    const allowed = this.getAllowedReasoningLevelsForPersona(persona);
    const current = persona.settings.reasoning;
    if (!allowed.includes(current)) {
      persona.settings.reasoning = allowed[0];
    }
  }

  private getStreamingSettings(persona: Persona) {
    const allowed = this.getAllowedReasoningLevelsForPersona(persona);
    const current = persona.settings.reasoning;
    const reasoning = allowed.includes(current) ? current : allowed[0];
    const settings = { ...persona.settings };
    if (reasoning) {
      settings.reasoning = reasoning;
    } else {
      delete (settings as any).reasoning;
    }
    return settings;
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

    const promptTokensSent =
      (last.usage?.input ?? 0) + (last.usage?.cacheRead ?? 0) + (last.usage?.cacheWrite ?? 0);
    const percent = windowTokens > 0 ? (promptTokensSent / windowTokens) * 100 : 0;
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
      this.editor.borderColor = editorBorderForReasoning(this.currentPersona.settings.reasoning);
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

function buildBaseSystemPrompt(args: {
  personaSystemPrompt: string;
  projectContextBlock?: string;
  environmentTag: string;
}): string {
  const parts: string[] = [args.personaSystemPrompt.trim()];
  if (args.projectContextBlock?.trim()) {
    parts.push(args.projectContextBlock.trim());
  }
  parts.push(args.environmentTag.trim());
  return parts.join("\n\n");
}

function buildProjectContextBlock(args: { cwd: string; home: string }): string | undefined {
  const agentsFiles = findAgentsFilesFromCwdToHome(args.cwd, args.home);
  if (agentsFiles.length === 0) return undefined;

  const lines: string[] = ["### Project context", ""];

  for (const filePath of agentsFiles) {
    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    lines.push(`<file path="${filePath}">`);
    lines.push(content.trimEnd());
    lines.push("</file>");
    lines.push("");
  }

  const out = lines.join("\n").trimEnd();
  return out.trim() ? out : undefined;
}

function findAgentsFilesFromCwdToHome(cwd: string, home: string): string[] {
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(home);

  // If we're not inside the user's home directory, don't walk beyond it.
  if (cwdAbs !== homeAbs && !cwdAbs.startsWith(homeAbs + sep)) {
    return [];
  }

  const found: string[] = [];

  let dir = cwdAbs;
  // Closest-first order: cwd, parent, ..., home.
  while (true) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) {
      found.push(candidate);
    }

    if (dir === homeAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    // Stay within home.
    if (parent !== homeAbs && !parent.startsWith(homeAbs + sep)) break;

    dir = parent;
  }

  return found;
}

function describeToolAccessLevel(level: ToolAccessLevel): string {
  switch (level) {
    case "none":
      return "No bash tool access for the model.";
    case "read":
      return "Model may call bash only for read-only commands (risk='read').";
    case "all":
      return "Model may call bash for read or write commands (risk='read' or 'write').";
  }
}

function buildEnvironmentTag(args: {
  datetime: string;
  cwd: string;
  toolAccessLevel: ToolAccessLevel;
}): string {
  const toolDesc = describeToolAccessLevel(args.toolAccessLevel);
  const nodeVersion = process.version;
  const platform = process.platform;
  return [
    "<environment>",
    `  <datetime>${args.datetime}</datetime>`,
    `  <cwd>${args.cwd}</cwd>`,
    `  <tool_access level="${args.toolAccessLevel}">${toolDesc}</tool_access>`,
    `  <node>${nodeVersion}</node>`,
    `  <platform>${platform}</platform>`,
    "  <notes>This environment tag is static for the session and reflects the initial tool access level. If the user changes tool access, you will be informed in a <system> tag at the start of the next user message.</notes>",
    "</environment>",
  ].join("\n");
}

function formatToolAccessChangeNotice(change: {
  from: ToolAccessLevel;
  to: ToolAccessLevel;
}): string {
  const toDesc = describeToolAccessLevel(change.to);
  return `<system>Tool access level changed by user from '${change.from}' to '${change.to}'. ${toDesc} This overrides the initial tool access described in the system prompt.</system>`;
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
