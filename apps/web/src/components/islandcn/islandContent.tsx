/**
 * Shared tile and glyph boxes for island content the DAK controller owns.
 * Matches the islandcn measure: a 22 pt compact glyph concentric with the
 * pill, a 52 pt expanded tile with the island's corner.
 */

import type { CSSProperties, ReactNode } from "react";

import { continuousCorner, islandSize, tint } from "./theme";

/** A 52 pt rounded tile for the expanded view's leading slot. */
export const IslandTile = ({
  children,
  color,
  style,
}: {
  readonly children: ReactNode;
  /** Accent the tile tints from; the icon carries the full-strength colour. */
  readonly color: string;
  readonly style?: CSSProperties;
}) => (
  <div
    aria-hidden
    style={{
      display: "grid",
      placeItems: "center",
      width: islandSize.expandedTile,
      height: islandSize.expandedTile,
      borderRadius: islandSize.expandedTileRadius,
      background: tint(color, 0.16),
      clipPath: continuousCorner(
        islandSize.expandedTile,
        islandSize.expandedTile,
        islandSize.expandedTileRadius,
      ),
      flex: "none",
      ...style,
    }}
  >
    {children}
  </div>
);

/** A 22 pt box for a compact leading icon, concentric with the pill's end. */
export const IslandCompactGlyph = ({ children }: { readonly children: ReactNode }) => (
  <span
    aria-hidden
    style={{
      display: "grid",
      placeItems: "center",
      width: islandSize.compactGlyph,
      height: islandSize.compactGlyph,
      flex: "none",
    }}
  >
    {children}
  </span>
);
