"use client";

import { type CSSProperties, useEffect, useState } from "react";

import { islandMetrics, useIslandReducedMotion } from "@/lib/island";

import { Glyph } from "./glyph";
import { type IslandGlyph, MicrophoneGlyph, PauseGlyph, PlayGlyph, ScreenRecordGlyph, VideoGlyph } from "./glyphs";
import { IslandRoundButton } from "./island-button";
import { IslandStyle } from "./island-style";
import { CompactText, MinimalPair, withBubble } from "./island-text";
import { LevelMeter } from "./level-meter";
import { islandAccent, islandFont, islandInk, islandSize, trackingFor } from "./theme";
import { TickingTime, type TickingTimeSource, formatClock } from "./ticking-time";
import { useActivity, useLatest } from "./use-activity";

const expanded = islandMetrics.expanded;

/**
 * The expanded view as the system's voice recorder lays it out: one row, measured on Apple's
 * marketing shot (perspective corrected, 371 pt island, 84 pt tall). On the left a waveform, its
 * bars growing from a centre line with grey dots where the recording hasn't reached; on the right
 * the elapsed time, then the stop button, concentric with the island's corner.
 */
const row = {
  /** The island's own minimum height, which Apple's view is: the row is what is left inside the padding (47.47). */
  height: expanded.minHeight - expanded.padding.top - expanded.padding.bottom,
  /** Waveform slot pitch: 15 bars and 11 dots across 137 pt. */
  pitch: 5.3,
  /** Bar width; the rest of the pitch is the gap. Apple's bars are a little wider than their gaps. */
  bar: 2.9,
  /** Dot diameter. */
  dot: 2.7,
  /** Bars in the row: where the recording has reached. */
  bars: 15,
  /** Grey dots after the bars, where it hasn't. */
  dots: 11,
  /**
   * With the pause button before the waveform: fewer bars, so the tallest stay left of the camera
   * (whose bottom edge is 37 pt down; the dots run on the centre line below it), and fewer dots.
   */
  barsBesidePause: 13,
  dotsBesidePause: 6,
  /** The tallest bar: 40 of the row's 47.5 pt. */
  peak: 40,
  /** The shortest bar. */
  floor: 4,
  /** The elapsed time: 22 pt regular, in tabular figures (a 15.8 pt figure height on Apple's). */
  time: 22,
  /** Between the time and the stop button. */
  timeGap: 10,
  /** The stop button: a 49 pt ring, 17.5 pt in from the island's edge all round. */
  stop: 49,
  /** The ring's line. */
  ring: 3,
  /** The red square inside it, and its corner. */
  square: 25,
  squareRadius: 6.5,
  /**
   * The optional pause button, at the left end before the waveform: smaller and grey, so the stop
   * ring still leads. Beside the time it ran the figures under the camera, which cut their tops.
   */
  pause: 36,
  /** Between the pause button and the waveform. */
  pauseGap: 10,
  /** Milliseconds per waveform slot: how fast the bars scroll while recording. */
  tick: 120,
} as const satisfies Record<string, number>;

/**
 * How far the stop ring reaches past the content box's trailing edge, so its centre sits on the
 * island corner's centre (the corner's radius is half the 84 pt height).
 */
const stopOverhang = row.stop / 2 - (expanded.minHeight / 2 - (expanded.padding.trailing ?? expanded.padding.side));

/** How far the pause button moves in past the content box's leading edge to sit concentric with the left corner. */
const pauseInset = expanded.minHeight / 2 - expanded.padding.side - row.pause / 2;

/** The waveform in compact: thin bars about as tall as the compact glyph, measured on Apple's pill (13 bars over 35 pt). */
const compactWave = { bars: 13, barWidth: 1.4, gap: 1.35, height: islandSize.compactGlyph } as const;
/** The waveform in the split's bubble and in minimal, which has room for a 22 pt glyph only. */
const smallWave = { bars: 5, barWidth: 2, gap: 2, height: 16 } as const;

/** The dots where the recording hasn't reached: grey, as Apple's are. */
const dotColor = "rgba(235, 235, 245, 0.42)";

export type RecordingKind = "audio" | "screen" | "camera";

/** Recording since a moment, or paused with the length so far. */
export type RecordingState = { kind: "recording"; since: number } | { kind: "paused"; elapsed: number };

export interface RecordingActivityProps {
  /** Activity id. Defaults to "recording". */
  id?: string;
  /** Higher priority takes the main pill when two activities run. Defaults to 0. */
  priority?: number;
  /** What is being recorded. Audio shows a waveform; screen and camera show their glyph and title. Defaults to "audio". */
  kind?: RecordingKind;
  state: RecordingState;
  /** Names the recording in the buttons' and activity's labels, and in the expanded row for screen and camera. Defaults to "Voice memo", "Screen recording" or "Video". */
  title?: string;
  /** Accent colour. Defaults to red. */
  accent?: string;
  /** The stop button at the right edge, a red square in a white ring; shown when set. Defaults to none. */
  onStop?: () => void;
  /**
   * A pause or resume button, a small grey circle at the left end before the waveform; shown when
   * set. Apple's recorder has none, so leave it out to match it. Defaults to none.
   */
  onTogglePause?: () => void;
  /** Live levels 0 to 1, oldest first, such as from an AnalyserNode: the newest are the waveform's bars (15, or 13 beside the pause button). Defaults to a built-in loop. */
  levels?: readonly number[];
}

const kinds = {
  audio: { icon: MicrophoneGlyph, title: "Voice memo" },
  screen: { icon: ScreenRecordGlyph, title: "Screen recording" },
  camera: { icon: VideoGlyph, title: "Video" },
} as const satisfies Record<RecordingKind, { icon: IslandGlyph; title: string }>;

// The pulse dips only to 0.7: lower, the red dot sank to a near-black brown on the black pill for
// half of every beat and read as off.
const dotCss = `
@keyframes icn-rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
.icn-rec-dot[data-live] { animation: icn-rec-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .icn-rec-dot[data-live] { animation: none; } }
`;

/** The red recording dot, pulsing while live. Sits in the 22 pt compact box. */
export const RecordingDot = ({ color = islandAccent.red, live = true, size = islandSize.compactGlyph }: {
  /** Dot colour. Defaults to red. */
  color?: string;
  /** Pulse while true; hold steady while false (paused). Defaults to true. */
  live?: boolean;
  /** Box size in pt. Defaults to 22. */
  size?: number;
}) => {
  const reduced = useIslandReducedMotion();
  const dot = Math.round(size * 0.5);
  return (
    <span aria-hidden style={{ display: "grid", placeItems: "center", width: size, height: size, flex: "none" }}>
      <IslandStyle id="rec-dot" css={dotCss} />
      <span
        className="icn-rec-dot"
        data-live={live && !reduced ? "" : undefined}
        style={{ width: dot, height: dot, borderRadius: live ? "50%" : 2, background: live ? color : islandInk.secondary }}
      />
    </span>
  );
};

// A cheap, stable pseudo-random number per bar, so the built-in waveform looks the same on every render.
const hash = (n: number) => {
  const x = Math.sin(n * 91.7 + 47.3) * 43758.5453;
  return x - Math.floor(x);
};

/** A bar's height in pt for a level from 0 to 1. */
const barHeight = (level: number) => row.floor + (row.peak - row.floor) * Math.min(1, Math.max(0, level));

/**
 * The built-in loop's level for bar `n`: speech-like, a few loud bars among quieter ones, with real
 * troughs between words (an even, loud block read as noise next to the recorder's waveform).
 */
const builtInLevel = (n: number) => {
  const r = hash(n);
  return r > 0.55 ? 0.72 + hash(n + 3) * 0.28 : 0.3 + r * 0.6;
};

const waveStrip: CSSProperties = { position: "relative", height: row.height, overflow: "hidden", flex: "none" };

/**
 * The expanded waveform. While recording, the bars scroll left one slot every `row.tick` ms and a
 * new one comes in at the edge where the dots begin, so the recording reads as moving forward.
 * Paused, or with reduced motion, it holds still. Live `levels` replace the built-in loop: the
 * newest sits at the right end of the bars.
 */
export const RecordingWave = ({ color, live = true, levels, bars = row.bars, dots = row.dots }: {
  /** Bar colour. */
  color: string;
  /** Scrolls while true; holds still while false (paused). Defaults to true. */
  live?: boolean;
  /** Live levels 0 to 1, oldest first; the newest are the bars. Defaults to a built-in loop. */
  levels?: readonly number[];
  /** Bars, where the recording has reached. Defaults to 15. */
  bars?: number;
  /** Grey dots after them, where it hasn't. Defaults to 11. */
  dots?: number;
}) => {
  const reduced = useIslandReducedMotion();
  const moving = live && !reduced && levels === undefined;
  const [seq, setSeq] = useState<number>(bars);
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => setSeq((n) => n + 1), row.tick);
    return () => window.clearInterval(timer);
  }, [moving]);

  const width = bars * row.pitch - (row.pitch - row.bar);
  const bar = (key: number, left: number, level: number) => {
    const h = barHeight(level);
    return <span key={key} style={{ position: "absolute", left, top: (row.height - h) / 2, width: row.bar, height: h, borderRadius: row.bar, background: color }} />;
  };

  // Bars by their sequence number: bar `n` sits at n x pitch on a strip that slides left as `seq`
  // grows, so the bar that comes in starts just past the clip and slides into the last slot.
  const strip = levels === undefined ? (
    <span
      style={{
        position: "absolute",
        inset: 0,
        transform: `translateX(${(bars - 1 - seq) * row.pitch}px)`,
        transition: moving ? `transform ${row.tick}ms linear` : "none",
      }}
    >
      {Array.from({ length: bars + 1 }, (_, index) => {
        const n = seq - bars + index;
        return bar(n, n * row.pitch, builtInLevel(n));
      })}
    </span>
  ) : (
    Array.from({ length: bars }, (_, index) => bar(index, index * row.pitch, levels[levels.length - bars + index] ?? 0))
  );

  return (
    <span aria-hidden style={{ display: "flex", alignItems: "center", gap: row.pitch - row.dot }}>
      <span style={{ ...waveStrip, width }}>{strip}</span>
      {Array.from({ length: dots }, (_, index) => (
        <span key={index} style={{ display: "block", width: row.dot, height: row.dot, borderRadius: "50%", background: dotColor, flex: "none" }} />
      ))}
    </span>
  );
};

/** The compact waveform's shape: two clusters of speech with small bars at the ends, as the recorder's compact view draws it. */
const compactEnvelope = [0.12, 0.25, 0.7, 0.48, 0.55, 0.22, 0.18, 0.7, 1, 0.6, 0.8, 0.28, 0.1] as const;

/** The compact waveform: thin bars that move while recording and rest while paused. "small" fits the split's bubble. */
export const CompactWave = ({ color, live = true, size = "compact" }: {
  /** Bar colour. */
  color: string;
  /** Moves while true. Defaults to true. */
  live?: boolean;
  /** "compact" for the pill, "small" for the split's bubble. Defaults to "compact". */
  size?: "compact" | "small";
}) => {
  const wave = size === "compact" ? compactWave : smallWave;
  return <LevelMeter bars={wave.bars} color={color} height={wave.height} barWidth={wave.barWidth} gap={wave.gap} active={live} envelope={size === "compact" ? compactEnvelope : undefined} />;
};

/** The stop button: a red rounded square inside a thin white ring, drawn as one SVG. */
const StopRing = ({ color }: { color: string }) => (
  <svg width={row.stop} height={row.stop} viewBox={`0 0 ${row.stop} ${row.stop}`} aria-hidden style={{ display: "block" }}>
    <circle cx={row.stop / 2} cy={row.stop / 2} r={(row.stop - row.ring) / 2} fill="none" stroke="#fff" strokeWidth={row.ring} />
    <rect x={(row.stop - row.square) / 2} y={(row.stop - row.square) / 2} width={row.square} height={row.square} rx={row.squareRadius} fill={color} />
  </svg>
);

/** Minutes always in two figures, as the recorder shows its time: "02:50", "1:02:09". */
const formatRecorder = (ms: number) => {
  const text = formatClock(ms);
  return /^\d:/.test(text) && text.length === 4 ? `0${text}` : text;
};

const timeStyle: CSSProperties = {
  fontFamily: islandFont,
  fontSize: row.time,
  fontWeight: 400,
  lineHeight: 1,
  letterSpacing: trackingFor(row.time),
  whiteSpace: "nowrap",
  WebkitFontSmoothing: "antialiased",
};

/**
 * The expanded row's trailing side: the elapsed time in 22 pt figures, then, with `onStop`, the
 * stop button (a red square in a white ring) centred on the row and pushed past the content edge,
 * so the ring is concentric with the island's corner.
 */
export const RecordingTrailing = ({ source, color, accent = islandAccent.red, stopLabel = "Stop recording", onStop }: {
  /** The time shown. */
  source: TickingTimeSource;
  /** The time's colour: the accent while recording, grey while paused. */
  color: string;
  /** The stop button's square. Defaults to red. */
  accent?: string;
  /** The stop button's spoken label. Defaults to "Stop recording". */
  stopLabel?: string;
  /** The stop button; shown when set. Defaults to none. */
  onStop?: () => void;
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: row.timeGap, height: row.height }}>
    <span style={{ ...timeStyle, color }}>
      <TickingTime source={source} format={formatRecorder} motion="none" />
    </span>
    {onStop === undefined ? null : (
      <span style={{ display: "flex", marginRight: -stopOverhang }}>
        <IslandRoundButton label={stopLabel} color="transparent" size={row.stop} onPress={onStop}>
          <StopRing color={accent} />
        </IslandRoundButton>
      </span>
    )}
  </div>
);

/**
 * A recording in progress, as the system's voice recorder shows it. Compact: a red waveform and
 * the elapsed time in red. Expanded: one row with the waveform on the left, its bars growing from
 * a centre line and grey dots where the recording hasn't reached, the time in large red figures,
 * and the stop button, a red square in a white ring, at the right edge. Screen and camera
 * recordings show the red dot in compact and their glyph and title in place of the waveform.
 */
export const RecordingActivity = ({
  id = "recording", priority = 0,
  kind = "audio",
  state,
  title,
  accent = islandAccent.red,
  onStop,
  onTogglePause,
  levels,
}: RecordingActivityProps) => {
  const handlers = useLatest({ onStop, onTogglePause });
  const hasStop = onStop !== undefined;
  const hasPause = onTogglePause !== undefined;
  const stateKey = state.kind === "recording" ? `r${state.since}` : `p${state.elapsed}`;
  const levelsKey = levels?.map((l) => Math.round(l * 20)).join(",") ?? "";

  useActivity(() => {
    const live = state.kind === "recording";
    const { icon, title: defaultTitle } = kinds[kind];
    const name = title ?? defaultTitle;
    const source: TickingTimeSource = live ? { kind: "elapsed", since: state.since } : { kind: "fixed", ms: state.elapsed };
    const color = live ? accent : islandInk.secondary;
    const audio = kind === "audio";
    // Regular, not semibold: the recorder's compact time reads as a clock, not a badge.
    const time = (
      <CompactText color={color} style={{ fontWeight: 400 }}>
        <TickingTime source={source} motion="none" />
      </CompactText>
    );
    const marker = audio ? <CompactWave color={color} live={live} /> : <RecordingDot color={accent} live={live} />;
    const small = audio ? <CompactWave color={color} live={live} size="small" /> : <RecordingDot color={accent} live={live} />;
    return {
      id,
      priority,
      label: live ? `Recording ${name}` : `${name} paused`,
      // The running time doesn't fit the split's bubble: there the waveform or dot shows alone.
      compact: withBubble({ leading: marker, trailing: time }, small),
      minimal: <MinimalPair leading={small} trailing={time} />,
      expanded: {
        leading: (
          <div style={{ display: "flex", alignItems: "center", gap: row.pauseGap, height: row.height }}>
            {hasPause ? (
              // Moved in so the circle is concentric with the island's left corner, as the stop ring is with the right.
              <span style={{ display: "flex", marginLeft: pauseInset }}>
                <IslandRoundButton label={live ? `Pause ${name}` : `Resume ${name}`} size={row.pause} onPress={() => handlers.current.onTogglePause?.()}>
                  {live ? <PauseGlyph size={16} /> : <PlayGlyph size={16} />}
                </IslandRoundButton>
              </span>
            ) : null}
            {audio ? (
              <RecordingWave
                color={color}
                live={live}
                levels={levels}
                bars={hasPause ? row.barsBesidePause : row.bars}
                dots={hasPause ? row.dotsBesidePause : row.dots}
              />
            ) : (
              // No wider than the waveform it stands in for, so a long title ends in an ellipsis instead of
              // pushing the time and the stop ring past the island's edge (Sol review, 390 pt with pause).
              <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, maxWidth: row.pitch * (hasPause ? row.barsBesidePause + row.dotsBesidePause : row.bars + row.dots) }}>
                <Glyph icon={icon} color={accent} />
                <CompactText style={{ minWidth: 0 }}>{name}</CompactText>
              </span>
            )}
          </div>
        ),
        trailing: (
          <RecordingTrailing source={source} color={color} accent={accent} stopLabel={`Stop ${name}`} onStop={hasStop ? () => handlers.current.onStop?.() : undefined} />
        ),
      },
    };
  }, [id, priority, kind, stateKey, title, accent, hasStop, hasPause, levelsKey]);

  return null;
};
