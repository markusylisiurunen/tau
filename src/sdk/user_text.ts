import {
  splitTauUserText,
  stripTauUserDisplayText,
  stripTauUserMetadata,
} from "../core/utils/user_metadata.js";

export type TauSdkUserTextProjection = {
  modelText: string;
  displayText: string;
};

export function projectTauUserText(text: string): TauSdkUserTextProjection {
  const split = splitTauUserText(text);
  return {
    modelText: split.modelText,
    displayText: split.displayText,
  };
}

export function getTauUserModelText(text: string): string {
  return stripTauUserMetadata(text);
}

export function getTauUserDisplayText(text: string): string {
  return stripTauUserDisplayText(text);
}
