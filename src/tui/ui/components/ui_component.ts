import type { Component } from "@earendil-works/pi-tui";

/**
 * UI components follow a simple lifecycle: construct -> update(model) -> render(width).
 * Implementations should treat update as a full re-render of their internal children/state.
 */
export interface UiComponent<Model> extends Component {
  update(model: Model): void;
}
