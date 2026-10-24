import { memo, type ReactNode } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { cn } from "~/lib/utils";

/**
 * The composer's grouped config inspector. One trigger replaces the row of
 * inline control pills; it opens a single macOS-style panel that groups every
 * turn setting under labeled sections (model, reasoning, mode, access) so the
 * always-visible bar stays just a config affordance next to attach and send.
 */
export const ComposerConfigInspector = memo(function ComposerConfigInspector(props: {
  sections: ReadonlyArray<{ id: string; label: string; content: ReactNode }>;
  size?: ComposerControlSize;
  /** Closes a still-open panel when its measured trigger hides in the strip. */
  hidden?: boolean;
  disabled?: boolean;
  triggerLabel?: ReactNode;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const size = props.size ?? "sm";

  const handleOpenChange = (next: boolean) => {
    if (props.disabled) {
      setOpen(false);
      return;
    }
    setOpen(next);
    props.onOpenChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            data-chat-composer-config-inspector="true"
            aria-label={props.triggerAriaLabel ?? "Turn settings"}
            className="shrink-0"
            disabled={props.disabled}
          />
        }
      >
        <ComposerControlIcon icon={SlidersHorizontalIcon} size={size} />
        {props.triggerLabel != null ? (
          <span data-composer-control-label className="min-w-0 truncate">
            {props.triggerLabel}
          </span>
        ) : null}
        <ComposerControlChevron size={size} />
      </PopoverTrigger>
      <PopoverPopup
        {...composerMenuProps}
        side="top"
        align="start"
        width="auto"
        padding="default"
        className="min-w-52 [&_[data-slot=separator]]:hidden"
      >
        <div className="flex flex-col gap-3">
          {props.sections.map((section) => (
            <div key={section.id} className="flex flex-col gap-1.5">
              <span className="px-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground/70">
                {section.label}
              </span>
              <div className="flex flex-wrap items-center gap-1">{section.content}</div>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
