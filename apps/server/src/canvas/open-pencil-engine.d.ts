/**
 * Types for the vendored OpenPencil document adapter.
 *
 * Same reasoning as `open-pencil.d.ts`: the module is plain `.mjs` under `strict` TypeScript, so
 * naming the one entry DAK uses keeps a signature change a compile error rather than a runtime
 * `TypeError` on somebody's design.
 */
declare module "@dak/canvas-engine/upstream/src/openpencil-engine.mjs" {
  export interface OpenPencilEditorOptions {
    /** Asked for the current viewport, so the editor lays out for a surface rather than the page. */
    getViewportSize?: () => { width: number; height: number };
    assets?: Map<string, unknown>;
  }

  export interface OpenPencilEditor {
    graph: { getPages(): ReadonlyArray<{ id: string }> };
    state: { zoom: number; panX: number; panY: number };
    destroy?: () => void;
  }

  export function createOpenPencilEditor(
    document: unknown,
    options?: OpenPencilEditorOptions,
  ): OpenPencilEditor;

  /**
   * Penkra's zoom-to-fit. Returns the chosen viewport, or null when the page has no nodes.
   *
   * DAK asks for a specific viewport instead of fitting, but the function is declared because it is
   * the reference for how a viewport is derived and a future caller will want the same behaviour.
   */
  export function fitOpenPencilDesign(
    editor: OpenPencilEditor,
    viewport: {
      width: number;
      height: number;
      left?: number;
      right?: number;
      top?: number;
      bottom?: number;
    },
  ): unknown;
}
