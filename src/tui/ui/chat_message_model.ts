import type { Component } from "@earendil-works/pi-tui";
import { AppIntroComponent, type AppIntroModel } from "./app_intro.js";
import { AssistantMessageComponent, type AssistantMessageModel } from "./assistant_message.js";
import { DiffReviewMessageComponent, type DiffReviewMessageModel } from "./diff_review_message.js";
import { SessionDividerComponent, type SessionDividerModel } from "./session_divider.js";
import type { SystemMessageModel } from "./system_message.js";
import { SystemMessageComponent } from "./system_message.js";
import type { Theme } from "./theme/index.js";
import { ToolCardComponent } from "./tool_card.js";
import type { ToolUiModel } from "./tool_ui_model.js";
import { UserMessageComponent, type UserMessageModel } from "./user_message.js";

export type ChatMessageModel =
  | (AppIntroModel & { type: "app_intro" })
  | AssistantMessageModel
  | (DiffReviewMessageModel & { type: "diff_review" })
  | (SystemMessageModel & { type: "system" })
  | (UserMessageModel & { type: "user" })
  | {
      type: "tool";
      tool: ToolUiModel;
    }
  | (SessionDividerModel & { type: "session_divider" });

export type { AssistantMessageModel };

export interface ChatMessageRenderOptions {
  theme: Theme;
  thoughtsVisible: boolean;
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
  const { theme, thoughtsVisible } = options;

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
    case "diff_review": {
      const component = new DiffReviewMessageComponent(theme, model);
      return {
        component,
        isAssistant: false,
        update: (nextModel, nextOptions) => {
          if (nextModel.type !== "diff_review") return false;
          component.setTheme(nextOptions.theme);
          component.update(nextModel);
          return true;
        },
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
        kind: model.kind,
      });
      return {
        component,
        isAssistant: false,
        update: (nextModel) => {
          if (nextModel.type !== "user") return false;
          component.update({ text: nextModel.text, kind: nextModel.kind });
          return true;
        },
      };
    }
    case "tool": {
      const component = new ToolCardComponent({ model: model.tool, theme });
      return {
        component,
        isAssistant: false,
        update: (nextModel, nextOptions) => {
          if (nextModel.type !== "tool") return false;
          component.update({ model: nextModel.tool, theme: nextOptions.theme });
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
