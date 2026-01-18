import type { Component } from "@mariozechner/pi-tui";
import { AppIntroComponent, type AppIntroModel } from "./app_intro.js";
import { AssistantMessageComponent, type AssistantMessageModel } from "./assistant_message.js";
import { SessionDividerComponent, type SessionDividerModel } from "./session_divider.js";
import { SessionSummaryComponent, type SessionSummaryModel } from "./session_summary.js";
import type { SystemMessageModel } from "./system_message.js";
import { SystemMessageComponent } from "./system_message.js";
import type { Theme } from "./theme/index.js";
import { buildToolOutputProps, renderToolOutput, type ToolOutputViewModel } from "./tool_output.js";
import { UserMessageComponent, type UserMessageModel } from "./user_message.js";

export type ChatMessageModel =
  | (AppIntroModel & { type: "app_intro" })
  | AssistantMessageModel
  | (SystemMessageModel & { type: "system" })
  | (UserMessageModel & { type: "user" })
  | {
      type: "tool";
      view: ToolOutputViewModel;
    }
  | (SessionDividerModel & { type: "session_divider" })
  | (SessionSummaryModel & { type: "session_summary" });

export type { AssistantMessageModel };

export interface ChatMessageRenderOptions {
  theme: Theme;
  thoughtsVisible: boolean;
  compactToolUi: boolean;
}

export interface RenderedMessage {
  component: Component;
  isAssistant: boolean;
  update?: (model: ChatMessageModel, options: ChatMessageRenderOptions) => boolean;
  hasVisibleText?: () => boolean;
}

export function isAssistantMessageModel(model: ChatMessageModel): model is AssistantMessageModel {
  return model.type === "assistant" || model.type === "assistant_partial";
}

export function renderChatMessage(
  model: ChatMessageModel,
  options: ChatMessageRenderOptions,
): RenderedMessage {
  const { theme, thoughtsVisible, compactToolUi } = options;

  switch (model.type) {
    case "app_intro": {
      const component = new AppIntroComponent(theme, {
        appName: model.appName,
        version: model.version,
        helpText: model.helpText,
      });
      return {
        component,
        isAssistant: false,
        update: (nextModel) => {
          if (nextModel.type !== "app_intro") return false;
          component.update({
            appName: nextModel.appName,
            version: nextModel.version,
            helpText: nextModel.helpText,
          });
          return true;
        },
      };
    }
    case "assistant": {
      const component = new AssistantMessageComponent(theme, model, thoughtsVisible);
      return {
        component,
        isAssistant: true,
        update: (nextModel, nextOptions) => {
          if (!isAssistantMessageModel(nextModel)) return false;
          component.setThinkingVisibility(nextOptions.thoughtsVisible);
          component.update(nextModel);
          return true;
        },
        hasVisibleText: () => component.hasVisibleText,
      };
    }
    case "assistant_partial": {
      const component = new AssistantMessageComponent(theme, model, thoughtsVisible);
      return {
        component,
        isAssistant: true,
        update: (nextModel, nextOptions) => {
          if (!isAssistantMessageModel(nextModel)) return false;
          component.setThinkingVisibility(nextOptions.thoughtsVisible);
          component.update(nextModel);
          return true;
        },
        hasVisibleText: () => component.hasVisibleText,
      };
    }
    case "system": {
      const component = new SystemMessageComponent(theme, {
        text: model.text,
        kind: model.kind,
      });
      return {
        component,
        isAssistant: false,
        update: (nextModel) => {
          if (nextModel.type !== "system") return false;
          component.update({ text: nextModel.text, kind: nextModel.kind });
          return true;
        },
      };
    }
    case "user": {
      const component = new UserMessageComponent(theme, {
        text: model.text,
        isMemoryMode: model.isMemoryMode,
      });
      return {
        component,
        isAssistant: false,
        update: (nextModel) => {
          if (nextModel.type !== "user") return false;
          component.update({ text: nextModel.text, isMemoryMode: nextModel.isMemoryMode });
          return true;
        },
      };
    }
    case "tool": {
      const component = renderToolOutput(model.view, compactToolUi);
      return {
        component,
        isAssistant: false,
        update: (nextModel, nextOptions) => {
          if (nextModel.type !== "tool") return false;
          component.update(buildToolOutputProps(nextModel.view, nextOptions.compactToolUi));
          return true;
        },
      };
    }
    case "session_divider": {
      const component = new SessionDividerComponent(theme, { label: model.label });
      return {
        component,
        isAssistant: false,
        update: (nextModel) => {
          if (nextModel.type !== "session_divider") return false;
          component.update({ label: nextModel.label });
          return true;
        },
      };
    }
    case "session_summary": {
      const component = new SessionSummaryComponent(theme, { summary: model.summary });
      return {
        component,
        isAssistant: false,
        update: (nextModel) => {
          if (nextModel.type !== "session_summary") return false;
          component.update({ summary: nextModel.summary });
          return true;
        },
      };
    }
  }
}
