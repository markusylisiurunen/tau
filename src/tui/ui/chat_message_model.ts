import type { Component } from "@mariozechner/pi-tui";
import type { ToolUiEvent } from "../../core/tools/registry.js";
import { AppIntroComponent, type AppIntroModel } from "./app_intro.js";
import { AssistantMessageComponent, type AssistantMessageModel } from "./assistant_message.js";
import { SessionDividerComponent, type SessionDividerModel } from "./session_divider.js";
import type { SystemMessageModel } from "./system_message.js";
import { SystemMessageComponent } from "./system_message.js";
import type { Theme } from "./theme/index.js";
import { buildToolOutputProps, renderToolOutput } from "./tool_output.js";
import type { ToolUiRegistry } from "./tool_ui_registry.js";
import { UserMessageComponent, type UserMessageModel } from "./user_message.js";

export type ChatMessageModel =
  | (AppIntroModel & { type: "app_intro" })
  | AssistantMessageModel
  | (SystemMessageModel & { type: "system" })
  | (UserMessageModel & { type: "user" })
  | {
      type: "tool";
      event: ToolUiEvent;
    }
  | (SessionDividerModel & { type: "session_divider" });

export type { AssistantMessageModel };

export interface ChatMessageRenderOptions {
  theme: Theme;
  thoughtsVisible: boolean;
  compactToolUi: boolean;
  toolUiRegistry: ToolUiRegistry;
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
  const { theme, thoughtsVisible, compactToolUi, toolUiRegistry } = options;

  switch (model.type) {
    case "app_intro": {
      const component = new AppIntroComponent(theme, {
        title: model.title,
        body: model.body,
      });
      return {
        component,
        isAssistant: false,
        update: (nextModel) => {
          if (nextModel.type !== "app_intro") return false;
          component.update({
            title: nextModel.title,
            body: nextModel.body,
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
      const view = toolUiRegistry.render(model.event, {
        theme,
        compact: compactToolUi,
      });
      const component = renderToolOutput(view, compactToolUi);
      return {
        component,
        isAssistant: false,
        update: (nextModel, nextOptions) => {
          if (nextModel.type !== "tool") return false;
          const nextView = nextOptions.toolUiRegistry.render(nextModel.event, {
            theme: nextOptions.theme,
            compact: nextOptions.compactToolUi,
          });
          component.update(buildToolOutputProps(nextView, nextOptions.compactToolUi));
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
  }
}
