import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { Component } from "@mariozechner/pi-tui";
import { AppIntroComponent } from "./app_intro.js";
import { AssistantMessageComponent } from "./assistant_message.js";
import { SessionDividerComponent } from "./session_divider.js";
import { SessionSummaryComponent } from "./session_summary.js";
import type { SystemMessageKind } from "./system_message.js";
import { SystemMessageComponent } from "./system_message.js";
import type { Theme } from "./theme/index.js";
import { renderToolOutput, type ToolOutputViewModel } from "./tool_output.js";
import { UserMessageComponent } from "./user_message.js";

export type ChatMessageModel =
  | {
      type: "app_intro";
      appName: string;
      version: string;
      helpText: string;
    }
  | {
      type: "assistant";
      message: AssistantMessage;
    }
  | {
      type: "assistant_partial";
      text: string;
      thinking?: string;
    }
  | {
      type: "system";
      text: string;
      kind: SystemMessageKind;
    }
  | {
      type: "user";
      text: string;
      isMemoryMode?: boolean;
    }
  | {
      type: "tool";
      view: ToolOutputViewModel;
    }
  | {
      type: "session_divider";
      label: string;
    }
  | {
      type: "session_summary";
      summary: string;
    };

export type AssistantMessageModel = Extract<
  ChatMessageModel,
  { type: "assistant" } | { type: "assistant_partial" }
>;

export interface ChatMessageRenderOptions {
  theme: Theme;
  thoughtsVisible: boolean;
  compactToolUi: boolean;
}

export interface RenderedMessage {
  component: Component;
  isAssistant: boolean;
}

export function isAssistantMessageModel(model: ChatMessageModel): model is AssistantMessageModel {
  return model.type === "assistant" || model.type === "assistant_partial";
}

export function updateAssistantComponent(
  component: AssistantMessageComponent,
  model: AssistantMessageModel,
  thoughtsVisible: boolean,
): void {
  component.setThinkingVisibility(thoughtsVisible);
  if (model.type === "assistant") {
    component.updateFromMessage(model.message);
  } else {
    component.updatePartial(model.text, model.thinking);
  }
}

export function renderChatMessage(
  model: ChatMessageModel,
  options: ChatMessageRenderOptions,
): RenderedMessage {
  const { theme, thoughtsVisible, compactToolUi } = options;

  switch (model.type) {
    case "app_intro":
      return {
        component: new AppIntroComponent(theme, model.appName, model.version, model.helpText),
        isAssistant: false,
      };
    case "assistant": {
      const component = new AssistantMessageComponent(theme, model.message, thoughtsVisible);
      return { component, isAssistant: true };
    }
    case "assistant_partial": {
      const component = new AssistantMessageComponent(theme, undefined, thoughtsVisible);
      component.updatePartial(model.text, model.thinking);
      return { component, isAssistant: true };
    }
    case "system":
      return {
        component: new SystemMessageComponent(theme, model.text, model.kind),
        isAssistant: false,
      };
    case "user":
      return {
        component: new UserMessageComponent(theme, model.text, {
          isMemoryMode: model.isMemoryMode,
        }),
        isAssistant: false,
      };
    case "tool":
      return { component: renderToolOutput(model.view, compactToolUi), isAssistant: false };
    case "session_divider":
      return { component: new SessionDividerComponent(theme, model.label), isAssistant: false };
    case "session_summary":
      return { component: new SessionSummaryComponent(theme, model.summary), isAssistant: false };
  }
}
