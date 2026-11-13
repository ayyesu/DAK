"use client";

import { useEffect, useState } from "react";

import { Glyph } from "./glyph";
import { CloseGlyph, PauseGlyph, PlayGlyph, TimerGlyph } from "./glyphs";
import { IslandRoundButton } from "./island-button";
import { ExpandedSide } from "./island-layout";
import { Caption, CompactText, ExpandedValue, MinimalPair, withBubble } from "./island-text";
import { ProgressRing } from "./progress-ring";
import { islandAccent, islandInk, islandSize, tint } from "./theme";
import { TickingTime, type TickingTimeSource } from "./ticking-time";
import { useActivity, useLatest } from "./use-activity";

/** A running timer counts down to `endsAt`; a paused one holds `remaining`. */
export type TimerState = { kind: "running"; endsAt: number } | { kind: "paused"; remaining: number };

export interface TimerActivityProps {
  /** Activity id. Defaults to "timer". */
  id?: string;
  /** Higher priority takes the main pill when two activities run. Defaults to 0. */
  priority?: number;
  /** Running (with an end time) or paused (with the time left). */
  state: TimerState;
  /** Full length in ms, for the ring in minimal. */
  duration: number;
  /** Name shown in the expanded view. Defaults to "Timer". */
  label?: string;
  /** Accent colour. Defaults to orange. */
  accent?: string;
  /** Pause or resume button in the expanded view; shown when set. Defaults to none. */
  onToggle?: () => void;
  /** Cancel button in the expanded view; shown when set. Defaults to none. */
  onCancel?: () => void;
  /** Called when a running timer reaches zero. Defaults to none. */
  onEnd?: () => void;
}

/**
 * The expanded row, as the system timer lays it out: 48 pt filled circles on the leading side, and a
 * small label over the big countdown on the trailing side, all on one centre line.
 */
const timerRow = {
  /** Button diameter: a little over the 44 pt touch target, as the Clock timer draws them. */
  button: 48,
  /** Space between the two buttons. */
  buttonGap: 10,
  /** The label's line box over the countdown: tight, so the pair reads as one block. */
  labelLine: 18,
  /**
   * The countdown's 34 pt line box has 2 pt below the digits' baseline that no figure fills, so the
   * block's ink would sit 1 pt above its box's centre. Trimming it centres the ink on the row.
   */
  valueTrim: 2,
} as const satisfies Record<string, number>;

/** The row's height: the label over the countdown (50 pt), which the buttons centre against. */
const rowHeight = timerRow.labelLine + islandSize.expandedValue - timerRow.valueTrim;

/** Where the remaining time comes from, for `TickingTime`. */
const sourceOf = (state: TimerState): TickingTimeSource =>
  state.kind === "running" ? { kind: "remaining", until: state.endsAt } : { kind: "fixed", ms: state.remaining };

const shareLeft = (state: TimerState, duration: number) => {
  const left = state.kind === "running" ? state.endsAt - Date.now() : state.remaining;
  return duration > 0 ? Math.min(1, Math.max(0, left / duration)) : 0;
};

/** A ring that drains as the timer runs. Only the ring re-renders each second. */
const TimerRing = ({ state, duration, accent }: { state: TimerState; duration: number; accent: string }) => {
  const [share, setShare] = useState(() => shareLeft(state, duration));
  useEffect(() => {
    setShare(shareLeft(state, duration));
    if (state.kind !== "running") return;
    const timer = window.setInterval(() => setShare(shareLeft(state, duration)), 1000);
    return () => window.clearInterval(timer);
  }, [state, duration]);
  return (
    <ProgressRing value={share} color={accent} track={tint(accent, 0.25)}>
      <TimerGlyph size={12} color={accent} />
    </ProgressRing>
  );
};

/**
 * A countdown timer. Compact shows the glyph and the time left in orange; minimal shows a ring;
 * expanded shows pause and cancel buttons on the left and the name over the big time on the right.
 */
export const TimerActivity = ({
  id = "timer", priority = 0,
  state,
  duration,
  label = "Timer",
  accent = islandAccent.orange,
  onToggle,
  onCancel,
  onEnd,
}: TimerActivityProps) => {
  const handlers = useLatest({ onToggle, onCancel, onEnd });
  const hasToggle = onToggle !== undefined;
  const hasCancel = onCancel !== undefined;
  const stateKey = state.kind === "running" ? `r${state.endsAt}` : `p${state.remaining}`;

  useActivity(() => {
    const source = sourceOf(state);
    const paused = state.kind === "paused";
    const time = (size: "compact" | "expanded") =>
      size === "compact" ? (
        <CompactText color={paused ? islandInk.secondary : accent}>
          <TickingTime source={source} />
        </CompactText>
      ) : (
        <ExpandedValue color={paused ? islandInk.secondary : accent} style={{ marginBottom: -timerRow.valueTrim }}>
          <TickingTime source={source} />
        </ExpandedValue>
      );
    const buttons = (
      <div style={{ display: "flex", gap: timerRow.buttonGap }}>
        {hasToggle ? (
          <IslandRoundButton
            label={paused ? `Resume ${label}` : `Pause ${label}`}
            color={tint(accent, 0.3)}
            iconColor={accent}
            size={timerRow.button}
            onPress={() => handlers.current.onToggle?.()}
          >
            {paused ? <PlayGlyph size={24} /> : <PauseGlyph size={24} />}
          </IslandRoundButton>
        ) : null}
        {hasCancel ? (
          <IslandRoundButton label={`Cancel ${label}`} size={timerRow.button} onPress={() => handlers.current.onCancel?.()}>
            <CloseGlyph size={20} />
          </IslandRoundButton>
        ) : null}
      </div>
    );
    return {
      id,
      priority,
      label: paused ? `${label} paused` : `${label} running`,
      // The time doesn't fit the split's bubble ("4:31" would read "4…"): there it is a draining ring.
      compact: withBubble({ leading: <Glyph icon={TimerGlyph} color={accent} />, trailing: time("compact") }, <TimerRing state={state} duration={duration} accent={accent} />),
      minimal: <MinimalPair leading={<TimerRing state={state} duration={duration} accent={accent} />} trailing={time("compact")} />,
      // As the system timer lays it out: the controls on the leading side, and the name in small accent
      // type over the big countdown on the trailing side. Both sides are as tall as the label and
      // countdown together, with the buttons centred in theirs, so the row shares one centre line and
      // the island is the row plus its insets, with even space above and below.
      expanded: {
        leading: (
          <ExpandedSide height={rowHeight}>
            {hasToggle || hasCancel ? buttons : <Glyph icon={TimerGlyph} color={accent} size={30} />}
          </ExpandedSide>
        ),
        trailing: (
          <div style={{ display: "grid", justifyItems: "end", rowGap: 0, textAlign: "right" }}>
            {/* Held 8 pt in from the trailing edge: it sits in the top corner's curve, and an expand that
                interrupts the split's opening left a tighter clip there that cut its last letter. */}
            <Caption color={paused ? islandInk.secondary : accent} style={{ fontSize: islandSize.subtitle, fontWeight: 600, lineHeight: `${timerRow.labelLine}px`, paddingRight: 8 }}>
              {paused ? "Paused" : label}
            </Caption>
            {time("expanded")}
          </div>
        ),
      },
    };
  }, [id, priority, stateKey, duration, label, accent, hasToggle, hasCancel]);

  // Fires here rather than from a clock in the content, which unmounts while the island is expanded.
  const endsAt = state.kind === "running" ? state.endsAt : null;
  useEffect(() => {
    if (endsAt === null) return;
    const timer = window.setTimeout(() => handlers.current.onEnd?.(), Math.max(0, endsAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [endsAt, handlers]);

  return null;
};
