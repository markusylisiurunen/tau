import type { Component } from "@mariozechner/pi-tui";
import { HeaderLineComponent, type HeaderLineModel } from "./components/header_line.js";
import type { OneLineSegment } from "./components/one_line_segments.js";
import { ToolOutputComponent } from "./tool_output.js";

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

function isComponent(value: HeaderLineModel | Component): value is Component {
  return typeof (value as Component).render === "function";
}

export function renderToolOutput(view: ToolOutputViewModel, compact: boolean): ToolOutputComponent {
  const header =
    view.compact.header === undefined
      ? undefined
      : isComponent(view.compact.header)
        ? view.compact.header
        : new HeaderLineComponent(view.compact.header);

  return new ToolOutputComponent({
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
  });
}
