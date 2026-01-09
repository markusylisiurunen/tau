import type { Component } from "@mariozechner/pi-tui";
import {
  type OneLineSegment,
  OneLineSegmentsComponent,
  WrappedSegmentsComponent,
} from "./one_line_segments.js";

export interface HeaderLineModel {
  segments: OneLineSegment[];
  flexIndices?: number[];
  wrapIndex?: number;
}

export class HeaderLineComponent implements Component {
  private inner: Component;

  constructor(model: HeaderLineModel) {
    this.inner =
      model.wrapIndex !== undefined
        ? new WrappedSegmentsComponent(model.segments, model.wrapIndex)
        : new OneLineSegmentsComponent(model.segments, model.flexIndices ?? []);
  }

  invalidate() {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }
}
