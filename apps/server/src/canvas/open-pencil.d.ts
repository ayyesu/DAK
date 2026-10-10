/**
 * Types for the vendored OpenPencil engine's surface DAK actually uses.
 *
 * The vendored modules are plain `.mjs` under `strict` TypeScript, so importing them is an implicit
 * `any` and every call through it loses checking at exactly the boundary where a mistake is expensive
 * — a renderer constructed with the wrong surface, a viewport that silently renders nothing. The
 * declarations below name only what DAK calls; the rest of the vendored surface is out of scope, and a
 * name that is not here should be a compile error rather than an unchecked call.
 *
 * Deliberately not `any`: if the vendored signature changes, these types are wrong and the test that
 * exercises them fails, which is the intended failure. A silent `any` would let a rename through to a
 * runtime `TypeError` on a user's design.
 */
declare module "@dak/canvas-engine/upstream/vendor/open-pencil/engine.source.mjs" {
  /** The subset of a CanvasKit surface DAK uses to read pixels back. */
  export interface CanvasKitSurfaceLike {
    makeImageSnapshot(): { encodeToBytes(): Uint8Array };
    delete(): void;
  }

  /** The Emscripten module the renderer needs. Only the members DAK touches are named. */
  export interface CanvasKitLike {
    MakeSurface(width: number, height: number): CanvasKitSurfaceLike | null;
  }

  export function getCanvasKit(options?: {
    locateFile?: (file: string) => string;
  }): Promise<CanvasKitLike>;

  /**
   * The world-space rectangle a render draws, in design coordinates.
   *
   * Note `w`/`h`, not `width`/`height`: the vendored engine reads these two names, and passing the
   * longer ones leaves the viewport undefined rather than erroring, so a scrolled render silently
   * matches an unscrolled one.
   */
  export interface WorldViewport {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  export class SkiaRenderer {
    constructor(ck: unknown, surface: unknown, third: unknown);
    /**
     * Pan and zoom are the render's real input: `render()` derives `worldViewport` from them as
     * `(-pan/zoom, -pan/zoom, width/zoom, height/zoom)`. Assigning `worldViewport` directly is
     * overwritten on the first frame, so a caller that scrolls by doing that gets identical images.
     */
    zoom: number;
    panX: number;
    panY: number;
    viewportWidth: number;
    viewportHeight: number;
    worldViewport: WorldViewport;
    pageId: string;
    /** Swaps the render target. It *deletes* the surface it replaces, so the constructor's surface
     * must not be the one being rendered into. */
    replaceSurface(surface: unknown): void;
    loadFonts(): Promise<unknown>;
    prepareForExport(
      graph: unknown,
      pageId: string,
      nodeIds: ReadonlyArray<string>,
    ): Promise<(() => void) | undefined | null>;
    render(graph: unknown, selectedIds: Set<string>): void;
  }

  /** The host-font seam Penkra owns and DAK now answers. */
  export interface FontManagerLike {
    setHostFontLoader(loader: (family: string, style: string) => Promise<ArrayBuffer | null>): void;
  }

  export const fontManager: FontManagerLike;
}
