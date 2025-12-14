import { type Component, Container, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "./components/dynamic_border.js";
import { type OneLineSegment, OneLineSegmentsComponent } from "./components/one_line_segments.js";

export interface ToolOutputExpandedView {
  borderColor: (text: string) => string;
  text: string;
  paddingX?: number;
  paddingY?: number;
}

export interface ToolOutputCompactView {
  segments: OneLineSegment[];
  flexIndices?: number[];
  extraText?: string;
  extraComponent?: Component;
  paddingX?: number;
  paddingY?: number;
}

export interface ToolOutputProps {
  compact: boolean;
  expanded: ToolOutputExpandedView;
  compactView: ToolOutputCompactView;
}

export class ToolOutputComponent extends Container {
  constructor(props: ToolOutputProps) {
    super();

    if (props.compact) {
      const { segments, flexIndices, extraText, extraComponent, paddingX, paddingY } =
        props.compactView;
      this.addChild(new OneLineSegmentsComponent(segments, flexIndices ?? []));

      if (extraComponent) {
        this.addChild(extraComponent);
      } else if (extraText && extraText.trim() !== "") {
        this.addChild(new Text(extraText, paddingX ?? 0, paddingY ?? 0));
      }

      return;
    }

    const { borderColor, text, paddingX, paddingY } = props.expanded;

    this.addChild(new DynamicBorder(borderColor));
    this.addChild(new Text(text, paddingX ?? 1, paddingY ?? 0));
    this.addChild(new DynamicBorder(borderColor));
  }
}
