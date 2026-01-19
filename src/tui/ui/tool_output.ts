import { type Component, Container, Text } from "@mariozechner/pi-tui";
import type { ToolUiLine, ToolUiText } from "../../core/tools/registry.js";
import { DynamicBorder } from "./components/dynamic_border.js";
import { HeaderLineComponent, type HeaderLineModel } from "./components/header_line.js";
import type { OneLineSegment } from "./components/one_line_segments.js";
import { OneLineSegmentsComponent } from "./components/one_line_segments.js";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface ToolOutputExpandedModel {
  title: string;
  sections?: Array<string | undefined>;
  paddingX?: number;
  paddingY?: number;
}

export interface ToolOutputCompactModel {
  header?: HeaderLineModel | Component;
  extraText?: string;
  extraComponent?: Component;
  paddingX?: number;
  paddingY?: number;
}

export interface ToolOutputViewModel {
  borderColor: (text: string) => string;
  expanded: ToolOutputExpandedModel;
  compact: ToolOutputCompactModel;
}

export interface HeaderSegmentsSpec {
  bulletStyle: (text: string) => string;
  bullet?: string;
  label: string;
  labelStyle: (text: string) => string;
  accent: string;
  accentStyle?: (text: string) => string;
}

export interface HeaderLineSpec extends HeaderSegmentsSpec {
  tailSegments?: OneLineSegment[];
  flexAccent?: boolean;
  flexTailIndices?: number[];
  wrapIndex?: number;
}

export function buildHeaderSegments(spec: HeaderSegmentsSpec): {
  segments: OneLineSegment[];
  accentIndex: number;
} {
  const bullet = spec.bullet ?? "▪";
  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: bullet, style: spec.bulletStyle },
    { text: " ", style: (s) => s },
    { text: spec.label, style: spec.labelStyle },
    { text: " ", style: (s) => s },
    { text: spec.accent, style: spec.accentStyle ?? ((s) => s) },
  ];
  return { segments, accentIndex: segments.length - 1 };
}

export function buildHeaderLine(spec: HeaderLineSpec): HeaderLineModel {
  const { segments, accentIndex } = buildHeaderSegments(spec);
  const baseLength = segments.length;
  if (spec.tailSegments && spec.tailSegments.length > 0) {
    segments.push(...spec.tailSegments);
  }
  const flexIndices: number[] = [];
  if (spec.flexAccent !== false) {
    flexIndices.push(accentIndex);
  }
  if (spec.flexTailIndices && spec.flexTailIndices.length > 0) {
    for (const idx of spec.flexTailIndices) {
      const absolute = baseLength + idx;
      if (absolute >= 0 && absolute < segments.length) {
        flexIndices.push(absolute);
      }
    }
  }
  return {
    segments,
    flexIndices,
    wrapIndex: spec.wrapIndex,
  };
}

export function buildSection(lines: Array<string | undefined>): string | undefined {
  const filtered = lines.filter((line): line is string => Boolean(line?.trim()));
  return filtered.length > 0 ? filtered.join("\n") : undefined;
}

export function buildExpandedText(expanded: ToolOutputExpandedModel): string {
  const sections = expanded.sections ?? [];
  const filteredSections = sections.filter((section): section is string => Boolean(section));
  const parts = [expanded.title, ...filteredSections];
  return parts.join("\n\n");
}

function styleToolUiLine(
  line: ToolUiLine,
  theme: Theme,
  baseStyle: (text: string) => string,
): string {
  if (!line.tone) return baseStyle(line.text);
  switch (line.tone) {
    case "diffAdd":
      return theme.palette.diffAdd(line.text);
    case "diffRemove":
      return theme.palette.diffRemove(line.text);
    default:
      return baseStyle(line.text);
  }
}

export function renderToolUiTextLines(args: {
  uiText: ToolUiText;
  kind: "preview" | "full";
  theme: Theme;
  baseStyle: (text: string) => string;
}): string | undefined {
  const { uiText, kind, theme, baseStyle } = args;
  const lines = kind === "preview" ? uiText.previewLines : uiText.fullLines;
  if (!lines.some((line) => line.text.trim())) return undefined;
  return lines.map((line) => styleToolUiLine(line, theme, baseStyle)).join("\n");
}

export interface ToolOutputExpandedView {
  borderColor: (text: string) => string;
  text: string;
  paddingX?: number;
  paddingY?: number;
}

export interface ToolOutputCompactView {
  headerComponent?: Component;
  segments?: OneLineSegment[];
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

export class ToolOutputComponent extends Container implements UiComponent<ToolOutputProps> {
  constructor(props: ToolOutputProps) {
    super();
    this.update(props);
  }

  update(props: ToolOutputProps): void {
    this.clear();
    if (props.compact) {
      const {
        headerComponent,
        segments,
        flexIndices,
        extraText,
        extraComponent,
        paddingX,
        paddingY,
      } = props.compactView;
      if (headerComponent) {
        this.addChild(headerComponent);
      } else if (segments) {
        this.addChild(new OneLineSegmentsComponent(segments, flexIndices ?? []));
      }

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

function isComponent(value: HeaderLineModel | Component): value is Component {
  return typeof (value as Component).render === "function";
}

export function renderToolOutput(view: ToolOutputViewModel, compact: boolean): ToolOutputComponent {
  return new ToolOutputComponent(buildToolOutputProps(view, compact));
}

export function buildBlockedToolView(args: {
  theme: Theme;
  label: string;
  title: string;
  accent: string;
  reason: string;
}): ToolOutputViewModel {
  const { theme, label, title, accent, reason } = args;
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.actionError(s);

  const msg = reason.trim();
  const section = buildSection(msg ? [errorColor(msg)] : []);

  const accentInline = inlineText(accent);
  const whyInline = inlineText(reason);

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    label,
    labelStyle: palette.textMuted,
    accent: accentInline,
    accentStyle: palette.brandAccent,
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(title)),
      sections: section ? [section] : [],
    },
    compact: {
      header,
      extraText: whyInline ? `    ${errorColor(whyInline)}` : undefined,
    },
  };
}

export function buildToolOutputProps(view: ToolOutputViewModel, compact: boolean): ToolOutputProps {
  const header =
    view.compact.header === undefined
      ? undefined
      : isComponent(view.compact.header)
        ? view.compact.header
        : new HeaderLineComponent(view.compact.header);

  return {
    compact,
    expanded: {
      borderColor: view.borderColor,
      text: buildExpandedText(view.expanded),
      paddingX: view.expanded.paddingX,
      paddingY: view.expanded.paddingY,
    },
    compactView: {
      headerComponent: header,
      extraText: view.compact.extraText,
      extraComponent: view.compact.extraComponent,
      paddingX: view.compact.paddingX,
      paddingY: view.compact.paddingY,
    },
  };
}
