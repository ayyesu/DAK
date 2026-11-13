"use client";

import { UploadGlyph } from "./glyphs";
import { BubbleForm } from "./island-text";
import { MediaLead, MediaLine, MediaText, MediaTrail, mediaCompact, mediaRow, ShareRing, Thumbnail } from "./media-row";
import { islandAccent } from "./theme";
import { useActivity, useLatest } from "./use-activity";

export interface UploadActivityProps {
  /** Activity id. Defaults to "upload". */
  id?: string;
  /** Higher priority takes the main pill when two activities run. Defaults to 0. */
  priority?: number;
  /** File name, the grey line in the expanded view. */
  fileName: string;
  /** Progress from 0 to 1. At 1 the activity shows a check and the done sentence. */
  progress: number;
  /** The photo or video frame being uploaded, shown as its thumbnail. Defaults to none (a tile with the upload glyph). */
  src?: string;
  /** Total size in bytes, for "2.5 of 6 MB" after the file name. Defaults to none (no size there). */
  totalBytes?: number;
  /** Where it's going, such as "Family", for "Uploading to Family". Defaults to none ("Uploading"). */
  destination?: string;
  /** The white sentence while it uploads, such as "Posting to your story". Defaults to "Uploading to" the destination. */
  title?: string;
  /** The white sentence once it's done, such as "Posted". Defaults to "Uploaded to" the destination. */
  doneTitle?: string;
  /** Accent colour of the ring and the check. Defaults to blue. */
  accent?: string;
  /**
   * Makes the expanded ring a stop button that calls this, as a nearby share's ring is. The size
   * still follows the file name; without `totalBytes` the percentage goes there instead, since the
   * ring no longer shows it. Defaults to none (the ring shows the percentage).
   */
  onCancel?: () => void;
}

const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal under 10, without a trailing zero: "2.5 of 6 MB", not "6.0".
  const shown = value < 10 && unit > 0 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
  return { value: shown, unit: units[unit] ?? "B" };
};

/** "2.5 of 6 MB" while it goes, "6 MB" once it's there, or null without a size. */
const sizeText = (totalBytes: number | undefined, value: number, done: boolean): string | null => {
  if (totalBytes === undefined) return null;
  const total = formatBytes(totalBytes);
  if (done) return `${total.value} ${total.unit}`;
  const sent = formatBytes(totalBytes * value);
  return `${sent.value} ${sent.unit === total.unit ? "" : `${sent.unit} `}of ${total.value} ${total.unit}`;
};

export interface UploadWords {
  /** What a screen reader says. */
  label: string;
  /** The white sentence: "Uploading to Family", or "Uploaded to Family" once it's done. */
  sentence: string;
  /** What follows the file name in the grey line ("2.5 of 6 MB", "6 MB", "42%"), or undefined for none. */
  detail: string | undefined;
}

type UploadWordsOptions = Pick<UploadActivityProps, "fileName" | "progress" | "totalBytes" | "destination" | "title" | "doneTitle"> & {
  /** Whether the expanded ring is a stop button, which takes the percentage out of the ring. */
  cancellable: boolean;
};

/**
 * The words the upload shows at a progress, so a test or an app's own view can say the same
 * thing the island does.
 */
export const uploadWords = ({ fileName, progress, totalBytes, destination, title, doneTitle, cancellable }: UploadWordsOptions): UploadWords => {
  const value = Math.min(1, Math.max(0, progress));
  const done = value >= 1;
  const percent = Math.floor(value * 100);
  const where = destination === undefined ? "" : ` to ${destination}`;
  const sentence = done ? (doneTitle ?? `Uploaded${where}`) : (title ?? `Uploading${where}`);
  const size = sizeText(totalBytes, value, done);
  // The size says how far it has gone. Without one, a stop button in the ring takes the ring's
  // percentage, so it moves after the name; the stop ring's arc still shows the progress.
  const detail = size ?? (cancellable && !done ? `${percent}%` : undefined);
  return { label: done ? `${sentence}: ${fileName}` : `${sentence}: ${fileName}, ${percent} percent`, sentence, detail };
};

/**
 * An upload, as a posting app shows one. Compact shows the photo's thumbnail and a ring with the
 * percentage in it; expanded is one row: the thumbnail large, the file name in grey over a white
 * sentence saying where it goes, and the ring large. At 1 the ring turns into a check and the
 * sentence into "Uploaded to …".
 */
export const UploadActivity = ({
  id = "upload", priority = 0,
  fileName,
  progress,
  src,
  totalBytes,
  destination,
  title,
  doneTitle,
  accent = islandAccent.blue,
  onCancel,
}: UploadActivityProps) => {
  const cancel = useLatest(onCancel);
  const hasCancel = onCancel !== undefined;
  const value = Math.min(1, Math.max(0, progress));
  const done = value >= 1;
  const percent = Math.floor(value * 100);

  useActivity(() => {
    const { label, sentence, detail } = uploadWords({ fileName, progress: value, totalBytes, destination, title, doneTitle, cancellable: hasCancel });
    const thumb = (size: number, radius: number) => <Thumbnail src={src} size={size} radius={radius} fallback={UploadGlyph} accent={accent} />;
    const ring = <ShareRing value={value} accent={accent} mark="count" />;
    return {
      id,
      priority,
      label,
      compact: {
        // The split's bubble leaves about 20 pt after its leading picture: a 22 pt thumbnail keeps the ring whole.
        leading: <BubbleForm bubble={thumb(mediaCompact.bubbleThumb, mediaCompact.thumbRadius)}>{thumb(mediaCompact.thumb, mediaCompact.thumbRadius)}</BubbleForm>,
        trailing: ring,
      },
      minimal: ring,
      expanded: {
        leading: <MediaLead>{thumb(mediaRow.photo, mediaRow.photoRadius)}</MediaLead>,
        center: <MediaText line={<MediaLine name={fileName} detail={detail} />} title={sentence} />,
        trailing: (
          <MediaTrail>
            <ShareRing
              value={value}
              accent={accent}
              size={mediaRow.ring}
              mark={hasCancel ? "stop" : "count"}
              onStop={hasCancel ? () => cancel.current?.() : undefined}
              stopLabel={`Stop uploading ${fileName}`}
            />
          </MediaTrail>
        ),
        bottom: undefined,
      },
    };
  }, [id, priority, fileName, src, percent, done, totalBytes, destination, title, doneTitle, accent, hasCancel]);

  return null;
};
