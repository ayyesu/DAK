"use client";

import type { CSSProperties, ReactNode } from "react";

import { islandMetrics, useIslandReducedMotion } from "@/lib/island";

import { Glyph, type GlyphIcon, IconTile } from "./glyph";
import { CarGlyph, HouseGlyph, type IslandGlyph, MessageGlyph, ParcelGlyph, PinGlyph, StarGlyph } from "./glyphs";
import { ExpandedBottom } from "./island-layout";
import { IslandStyle } from "./island-style";
import { CompactText, ExpandedSubtitle, ExpandedTitle, MinimalPair, withBubble } from "./island-text";
import { islandAccent, islandBaseline, islandFont, islandInk, islandLine, islandSafe, islandSize, tint, trackingFor } from "./theme";
import { formatMinutes, TickingTime } from "./ticking-time";
import { useActivity, useLatest } from "./use-activity";

export type EtaKind = "ride" | "delivery";

export interface EtaActivityProps {
  /** Activity id. Defaults to "eta". */
  id?: string;
  /** Higher priority takes the main pill when two activities run. Defaults to 0. */
  priority?: number;
  /** A ride (a car) or a delivery (a package). Picks the glyph. Defaults to "ride". */
  kind?: EtaKind;
  /** When it gets there, epoch ms. The minutes count down on their own. */
  arrivesAt: number;
  /** Headline, such as "Driver is on the way". Read by screen readers; shown at the top right only when there is no `driverName` and no plate. */
  title: string;
  /**
   * The car and plate as one line, the older form of `plate` and `vehicle`. For a ride, "7KXR482 ·
   * Silver estate" reads as the plate, then the car; any other text reads as `vehicle`. Defaults to none.
   */
  subtitle?: string;
  /**
   * How far along the route, 0 to 1. Kept so existing code compiles; the views follow the platform's
   * guideline layout for this activity, which has no route bar, so nothing shows it. Defaults to none.
   */
  progress?: number;
  /** Who is coming, such as "Kofi A.": the top right, with the plate under it. Defaults to none. */
  driverName?: string;
  /** The plate, such as "7KXR482": under the driver's name, or in its place when there is none. Defaults to the first part of a ride's `subtitle`. */
  plate?: string;
  /** What is coming, such as "Silver estate" or "3 items": the left of the arrival row. Defaults to the rest of `subtitle`. */
  vehicle?: string;
  /**
   * Shows a full-width "Message <first name>" capsule at the bottom and calls this when it is
   * pressed. Defaults to none: no capsule.
   */
  onContact?: () => void;
  /** The capsule's words, such as "Contact Juan C.". Defaults to "Message <first name>". */
  contactLabel?: string;
  /** The courier's or driver's rating out of 5, in halves, such as 4.5: stars under the name in place of the plate. Defaults to none. */
  rating?: number;
  /** A short service name for compact's leading side, such as "Ride": a word in place of the vehicle glyph. Defaults to none (the glyph). */
  service?: string;
  /** Accent colour: the glyph, the minutes and the capsule. Defaults to green for rides and yellow for deliveries. */
  accent?: string;
}

const glyphs = {
  ride: { vehicle: CarGlyph, destination: PinGlyph },
  delivery: { vehicle: ParcelGlyph, destination: HouseGlyph },
} as const satisfies Record<EtaKind, { vehicle: IslandGlyph; destination: IslandGlyph }>;

const routeCss = `
.icn-route-fill { transition: transform 600ms cubic-bezier(0.22, 1, 0.36, 1); transform-origin: 0 50%; }
.icn-route-marker { transition: transform 600ms cubic-bezier(0.22, 1, 0.36, 1); }
@media (prefers-reduced-motion: reduce) { .icn-route-fill, .icn-route-marker { transition: none; } }
`;

/**
 * A route from start to destination with the vehicle on it. The preset no longer shows it (the guideline
 * layout has no place for it); it stays exported for islands that want one.
 */
export const RouteBar = ({ progress, accent, vehicle, destination }: {
  /** 0 to 1 along the route. */
  progress: number;
  /** Colour of the travelled part and the marker. */
  accent: string;
  /** Glyph in the moving marker: an islandcn glyph, or an icon from another set. */
  vehicle: GlyphIcon;
  /** Glyph at the end: an islandcn glyph, or an icon from another set. */
  destination: GlyphIcon;
}) => {
  const reduced = useIslandReducedMotion();
  const p = Math.min(1, Math.max(0, progress));
  const marker = 26;
  return (
    <div aria-hidden style={{ position: "relative", height: marker, margin: "0 2px" }}>
      <IslandStyle id="route" css={routeCss} />
      {/* The route runs from the start dot to just before the destination glyph. */}
      <div style={{ position: "absolute", left: 4, right: 24, top: "50%", height: 4, marginTop: -2, borderRadius: 2, background: islandInk.track, overflow: "hidden" }}>
        <div className={reduced ? undefined : "icn-route-fill"} style={{ position: "absolute", inset: 0, background: accent, transform: `scaleX(${p})`, transformOrigin: "0 50%" }} />
      </div>
      <span style={{ position: "absolute", left: 0, top: "50%", width: 8, height: 8, marginTop: -4, borderRadius: "50%", background: accent }} />
      <span style={{ position: "absolute", right: 0, top: 0, width: 22, height: marker, display: "grid", placeItems: "center", color: islandInk.primary }}>
        <Glyph icon={destination} size={20} color={islandInk.primary} />
      </span>
      {/* A box as wide as the route slides by its own width times progress, so the marker moves on the compositor. */}
      <div style={{ position: "absolute", left: 4, right: 24, top: 0, height: marker, pointerEvents: "none" }}>
        <div className={reduced ? undefined : "icn-route-marker"} style={{ position: "absolute", inset: 0, transform: `translateX(${p * 100}%)` }}>
          {/* The vehicle on a round accent tile, ringed in black so the route reads as passing under it. */}
          <span style={{ position: "absolute", top: 0, left: -marker / 2, width: marker, height: marker, borderRadius: "50%", boxShadow: "0 0 0 3px #000" }}>
            <IconTile icon={vehicle} accent={accent} size={marker} shape="circle" />
          </span>
        </div>
      </div>
    </div>
  );
};

const expanded = islandMetrics.expanded;
const trailingPad = expanded.padding.trailing ?? expanded.padding.side;
/** The top-trailing corner's centre, measured from the content box's top-right corner. */
const topCorner = { x: expanded.radius - trailingPad, y: expanded.radius - expanded.padding.top };
/** The content clip's corner arc, less 1 pt so sub-pixel layout never touches it. */
const clipReach = islandMetrics.contentClip.radius - 1;
/** A 17 pt cap's top below its line's top: the baseline less the cap height (0.705 em). */
const titleCapTop = islandBaseline.title - Math.round(islandSize.title * 0.705);
/**
 * The top row's height: the name's 22 pt line, 1 pt, and the plate's 20 pt line. The glyph sits
 * in a frame this tall whatever its size, so the arrival row lands on the same line either way.
 */
const topRow = islandLine.title + islandLine.stackGap + islandLine.subtitle;
/** The capsule's ends from the island's sides: 20.8 pt, the drawing's 20.6 and 20.7 widened by 374.34 / 371. */
const capsuleSide = 20.8;
/** Where the arrival row starts, in from the content box: 21.5 pt from the island's edge, as the drawing's "3 items". */
const rowStart = 3;

/**
 * The platform's guideline drawing of this activity (a delivery: the courier's name top right, "3 items"
 * and "Arriving in 8 minutes" under it, a "Contact" capsule at the foot), measured at 1.345 px per
 * pt and widened by 374.34 / 371 to this engine's expanded width. Distances are pt from the content
 * box (18.5 in from the leading edge, 17.81 from the trailing one, 18.18 from the top).
 */
const layout = {
  /**
   * The vehicle glyph's ink starts 21.5 pt from the island's leading edge and centres 40.95 pt
   * below its top (the drawing's bag: 42 by 39 pt at 21.3 and 21.6). Box size and offset per glyph,
   * since the car is wide and flat (41 by 26 pt of ink) and the parcel about square (37 by 39).
   */
  glyph: {
    ride: { size: 44, left: 1.4, top: 0.9 },
    delivery: { size: 42, left: 0.7, top: 1.9 },
  },
  /**
   * The name's right edge in from the content box: the drawing sets it 22.4 pt from the island's
   * edge, but there the top corner's arc would cut the last letter's cap (34.4 pt about a corner
   * 47.9 pt in). This is the least inset that keeps a 17 pt cap on the content top clear of it (7.7,
   * 25.5 pt from the edge). The arrival row lines up under it, as the drawing's rows do.
   */
  trailingInset: Math.ceil((topCorner.x - Math.sqrt(clipReach ** 2 - (topCorner.y - titleCapTop) ** 2)) * 10) / 10,
  /** The arrival row's left edge: 21.5 pt from the island's edge, under the glyph's ink. */
  leadingInset: rowStart,
  /**
   * The arrival row's line top: its baseline 79.9 pt below the island's top in the drawing, 61.7
   * below the content top. The bottom region starts `topRow` + the engine's 8 pt row gap down, so
   * it moves up the difference.
   */
  rowLift: 61.7 - islandBaseline.title - topRow - expanded.rowGap,
  /**
   * With no capsule the arrival row is the last, and the bottom-leading corner's arc would cut its
   * first letter at the baseline (21.5 pt in): it rises just far enough that the arc clears the
   * baseline's start (4.1 pt), where a full lift would leave a 14 pt band of black under it.
   */
  footLift:
    Math.ceil(
      (expanded.radius -
        Math.sqrt(clipReach ** 2 - (expanded.radius - expanded.padding.side - rowStart) ** 2) -
        (expanded.padding.bottom + islandLine.title - islandBaseline.title)) *
        10,
    ) / 10,
  /** The arrival row's baseline to the capsule's top: 16 pt, so 11 below its 22 pt line. */
  capsuleGap: 11,
  /** The capsule's side insets in the content box. */
  capsuleSide: { leading: capsuleSide - expanded.padding.side, trailing: capsuleSide - trailingPad },
  /**
   * The capsule's gap to the island's foot matches its gap to the sides, 20.8 pt, as the platform's
   * expanded ride layouts frame a full-width button evenly. The engine pads the bottom 18.35, so the
   * capsule rises the difference. Lower, it sits nearer the foot than the sides and its round ends
   * run into the content clip's corner arcs (34.4 pt about centres 47.9 pt in), which shaved them at
   * the old 15.7. Here each end's circle sits 5.2 pt inside its arc.
   */
  capsuleRise: capsuleSide - expanded.padding.bottom,
  /**
   * The capsule's label: 20 pt semibold (a 14.9 pt cap), after a 28 pt message glyph (22 pt of ink)
   * and a 9.7 pt gap from the glyph's ink, which stops 3.1 pt short of its box.
   */
  capsuleText: 20,
  capsuleGlyph: 28,
  capsuleGlyphGap: 9.7 - 3.1,
  /** The capsule's fill: the accent at 27% on black (#1a3948 under #64d2ff in the drawing). */
  capsuleTint: 0.27,
} as const satisfies Record<string, unknown>;

/** One line of the arrival row: 17 pt semibold, the same type as the name. */
const rowText: CSSProperties = { flex: "0 1 auto", minWidth: 0 };

const contactCss = `
.icn-eta-contact {
  appearance: none; border: 0; margin: 0; padding: 0 18px; cursor: pointer; user-select: none;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  display: flex; align-items: center; justify-content: center; width: 100%; min-width: 0;
  font-family: ${islandFont}; font-weight: 600; -webkit-font-smoothing: antialiased;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), filter 160ms ease-out;
}
@media (hover: hover) and (pointer: fine) { .icn-eta-contact:hover { filter: brightness(1.15); } }
.icn-eta-contact:active { transform: scale(0.97); filter: brightness(0.9); }
.icn-eta-contact:focus-visible { outline: 2px solid var(--icn-ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .icn-eta-contact { transition: none; } .icn-eta-contact:active { transform: none; } }
.icn-eta-contact[data-reduced] { transition: none; }
.icn-eta-contact[data-reduced]:active { transform: none; }
`;

/**
 * The full-width capsule at the foot of the guideline layout: a message glyph and "Message Kofi" in
 * the accent on an accent-tinted fill. Its own button rather than `IslandButton`, which fills with
 * the accent and sets 17 pt type; the drawing tints the fill and sets 20 pt.
 */
const ContactCapsule = ({ label, accent, onPress }: { label: string; accent: string; onPress: () => void }) => {
  const reduced = useIslandReducedMotion();
  const style = {
    height: islandSize.button,
    borderRadius: islandSize.button / 2,
    background: tint(accent, layout.capsuleTint),
    color: accent,
    fontSize: layout.capsuleText,
    lineHeight: 1,
    letterSpacing: trackingFor(layout.capsuleText),
    gap: layout.capsuleGlyphGap,
    "--icn-ring": accent,
  } as const satisfies CSSProperties & Record<`--icn-${string}`, string | number>;
  return (
    <button
      type="button"
      className="icn-eta-contact"
      data-reduced={reduced ? "" : undefined}
      style={style}
      // Presses inside island content must not reach the island's own long-press handling.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      <IslandStyle id="eta-contact" css={contactCss} />
      <Glyph icon={MessageGlyph} color={accent} size={layout.capsuleGlyph} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
};

/**
 * The vehicle large in the accent, tight to the top-left corner beside the sensor, in a frame as
 * tall as the name and plate opposite, so the arrival row lands on the same line whatever its size.
 */
export const EtaVehicle = ({ icon, color, kind = "ride" }: {
  /** The vehicle's glyph: an islandcn glyph, or an icon from another set. */
  icon: GlyphIcon;
  /** Its colour, the accent. */
  color: string;
  /** Sizes and places it: "ride" for a wide, flat glyph such as the car, "delivery" for a square one. Defaults to "ride". */
  kind?: EtaKind;
}) => {
  const box = layout.glyph[kind];
  return (
    <div style={{ height: topRow }}>
      {/* Moved, not margined: a top margin would fall through the frame and push the whole row down. */}
      <div style={{ position: "relative", left: box.left, top: box.top }}>
        <Glyph icon={icon} color={color} size={box.size} />
      </div>
    </div>
  );
};

/** The driver's name top right, with the plate in grey under it, clear of the corner's arc. */
export const EtaDriver = ({ name, detail, rating, accent = islandAccent.green }: {
  /** The name, or the plate when there is no name. */
  name: string;
  /** The line under it, such as the plate. Defaults to none. */
  detail?: string;
  /** A rating out of 5 in halves: stars in place of `detail`, as the guideline drawing shows a courier's. Defaults to none. */
  rating?: number;
  /** The stars' colour. Defaults to green. */
  accent?: string;
}) => (
  <div style={{ display: "grid", gap: islandLine.stackGap, justifyItems: "end", textAlign: "right", minWidth: 0, maxWidth: islandSafe.besideSensor, paddingRight: layout.trailingInset }}>
    <ExpandedTitle style={{ maxWidth: "100%", ...regular }}>{name}</ExpandedTitle>
    {rating !== undefined ? (
      <StarRating value={rating} color={accent} />
    ) : detail === undefined || detail === "" ? null : (
      <ExpandedSubtitle style={{ maxWidth: "100%" }}>{detail}</ExpandedSubtitle>
    )}
  </div>
);

/**
 * The expanded bottom: what is coming on the left and "Arriving in 6 min" on the right, the minutes
 * in the accent, then, with `contact`, the full-width tinted capsule at the foot.
 */
export const EtaArrival = ({ vehicle, minutes, accent, contact }: {
  /** What is coming, such as "Silver estate" or "3 items". Defaults to none. */
  vehicle?: string;
  /** The time left with its unit, such as a `TickingTime` with `formatArrivalMinutes` ("6 minutes"). */
  minutes: ReactNode;
  /** The minutes' and the capsule's colour. */
  accent: string;
  /** The capsule's words, such as "Message Kofi", and what pressing it does. Defaults to none: no capsule. */
  contact?: { label: string; onPress: () => void };
}) => {
  const arrival = (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        minWidth: 0,
        paddingLeft: layout.leadingInset,
        paddingRight: layout.trailingInset,
      }}
    >
      {vehicle === undefined || vehicle === "" ? <span /> : <ExpandedTitle style={{ ...rowText, ...regular }}>{vehicle}</ExpandedTitle>}
      {/* The time keeps its width; the car's name gives way first. */}
      <ExpandedTitle style={{ flex: "none", ...regular }}>
        Arriving in <span style={{ color: accent }}>{minutes}</span>
      </ExpandedTitle>
    </div>
  );
  return contact === undefined ? (
    // Alone at the foot, the row's first letter would reach the corner arc: it rises clear.
    <ExpandedBottom style={{ marginTop: layout.rowLift, paddingBottom: layout.footLift }}>{arrival}</ExpandedBottom>
  ) : (
    <ExpandedBottom gap={layout.capsuleGap} style={{ marginTop: layout.rowLift }}>
      {arrival}
      <div style={{ paddingLeft: layout.capsuleSide.leading, paddingRight: layout.capsuleSide.trailing, marginBottom: layout.capsuleRise }}>
        <ContactCapsule label={contact.label} accent={accent} onPress={contact.onPress} />
      </div>
    </ExpandedBottom>
  );
};

const arrivalTime = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** What each line shows, from the props given: newer props win, then the older `subtitle`. */
const resolveLines = ({ kind, title, subtitle, driverName, plate, vehicle }: Pick<EtaActivityProps, "title" | "subtitle" | "driverName" | "plate" | "vehicle"> & { kind: EtaKind }) => {
  const [first = "", ...rest] = subtitle?.split(" · ") ?? [];
  // Only a ride's "plate · car" pair splits; a delivery's subtitle ("Two items from Corner Deli") is what is coming.
  const split = kind === "ride" && rest.length > 0;
  const plateText = plate ?? (split ? first : undefined);
  const vehicleText = vehicle ?? (split ? rest.join(" · ") : subtitle);
  return {
    name: driverName ?? plateText ?? title,
    detail: driverName === undefined ? undefined : plateText,
    vehicle: vehicleText,
  };
};

/** The name, the car and the arrival line: regular, as the guideline drawing sets them; semibold made the card dense. */
const regular = { fontWeight: 400 } as const satisfies CSSProperties;

/** A short service name in compact: 18 pt regular white, no wider than a compact glyph pair, as a ride app's wordmark sits there. */
const serviceText = { fontSize: 18, fontWeight: 400, maxWidth: 42, overflow: "hidden", textOverflow: "clip" } as const satisfies CSSProperties;

/** "1 minute", "6 minutes". */
const withUnit = (count: string, one: string, many: string) => `${count} ${count === "1" ? one : many}`;

/** The arrival line's time: whole minutes with the whole unit, "6 minutes", as the guideline drawing writes it. */
export const formatArrivalMinutes = (ms: number): string => withUnit(formatMinutes(ms), "minute", "minutes");

/**
 * A rating under the name, as the guideline drawing shows the courier's: five 12 pt stars (the
 * glyph set's solid star) 3 pt apart, filled to the rating in halves, the rest in the accent at a third.
 */
const StarRating = ({ value, color }: { value: number; color: string }) => {
  const filled = Math.round(Math.min(5, Math.max(0, value)) * 2) / 2;
  return (
    <span role="img" aria-label={`Rated ${filled} out of 5`} style={{ display: "flex", gap: 3, height: 14, alignItems: "center" }}>
      {Array.from({ length: 5 }, (_, index) => {
        const share = Math.min(1, Math.max(0, filled - index));
        return (
          <span key={index} aria-hidden style={{ position: "relative", width: 12, height: 12, flex: "none" }}>
            <StarGlyph size={12} color={color} style={{ position: "absolute", inset: 0, opacity: 0.33 }} />
            {share > 0 ? <StarGlyph size={12} color={color} style={{ position: "absolute", inset: 0, clipPath: `inset(-2px ${(1 - share) * 100}% -2px -2px)` }} /> : null}
          </span>
        );
      })}
    </span>
  );
};

/** "Message Kofi" for "Kofi A.", or the role when no name is given. */
const defaultContactLabel = (kind: EtaKind, driverName: string | undefined) => {
  const first = driverName?.trim().split(/\s+/)[0];
  return `Message ${first === undefined || first === "" ? (kind === "ride" ? "driver" : "courier") : first}`;
};

/**
 * A ride or delivery on its way, laid out as the platform's design guidelines draw this activity. Compact shows
 * the vehicle and the minutes in the accent (a `service` name in white), the colour expanded keeps; expanded puts the vehicle glyph large in the top-left
 * corner, the driver's name and plate top right, the car on the left of the next row and
 * "Arriving in 6 min" on its right with the minutes in the accent, and, with `onContact`, a
 * full-width tinted "Message" capsule at the foot.
 */
export const EtaActivity = ({
  id = "eta",
  priority = 0,
  kind = "ride",
  arrivesAt,
  title,
  subtitle,
  driverName,
  plate,
  vehicle: vehicleProp,
  onContact,
  contactLabel,
  rating,
  service,
  accent: accentProp,
}: EtaActivityProps) => {
  const accent = accentProp ?? (kind === "ride" ? islandAccent.green : islandAccent.yellow);
  const { vehicle } = glyphs[kind];
  const handlers = useLatest({ onContact });
  const contactable = onContact !== undefined;

  useActivity(() => {
    // The whole unit where there is room, as the guideline drawing's "8 minutes"; "6 mins" in compact.
    const minutesLong = <TickingTime source={{ kind: "remaining", until: arrivesAt }} format={formatArrivalMinutes} />;
    const minutesShort = <TickingTime source={{ kind: "remaining", until: arrivesAt }} format={(ms) => withUnit(formatMinutes(ms), "min", "mins")} />;
    const minutes = <TickingTime source={{ kind: "remaining", until: arrivesAt }} format={formatMinutes} />;
    const lines = resolveLines({ kind, title, subtitle, driverName, plate, vehicle: vehicleProp });
    return {
      id,
      priority,
      label: `${title}, arriving at ${arrivalTime(arrivesAt)}`,
      // The car and the minutes in the accent, the colour the expanded view's car and minutes carry,
      // so opening it doesn't switch white to green (a service wordmark stays white, as a brand's
      // does). "6 min" doesn't fit the split's bubble, so there the vehicle shows alone.
      compact: withBubble(
        {
          leading: service === undefined ? <Glyph icon={vehicle} color={accent} /> : <CompactText style={serviceText}>{service}</CompactText>,
          trailing: <CompactText color={accent} style={regular}>{minutesShort}</CompactText>,
        },
        <Glyph icon={vehicle} color={accent} />,
      ),
      minimal: <MinimalPair leading={<Glyph icon={vehicle} color={accent} />} trailing={<CompactText color={accent}>{minutes}m</CompactText>} />,
      expanded: {
        leading: <EtaVehicle icon={vehicle} color={accent} kind={kind} />,
        trailing: <EtaDriver name={lines.name} detail={lines.detail} rating={rating} accent={accent} />,
        bottom: (
          <EtaArrival
            vehicle={lines.vehicle}
            minutes={minutesLong}
            accent={accent}
            contact={contactable ? { label: contactLabel ?? defaultContactLabel(kind, driverName), onPress: () => handlers.current.onContact?.() } : undefined}
          />
        ),
      },
    };
  }, [id, priority, kind, arrivesAt, title, subtitle, driverName, plate, vehicleProp, contactable, contactLabel, rating, service, accent]);

  return null;
};
