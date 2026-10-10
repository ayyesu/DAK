"use client";

import type { CanvasDocumentSummary, ProjectId, ScopedThreadRef } from "@dak/contracts";
import { Frame } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useRightPanelStore } from "~/rightPanelStore";
import { useCanvasList } from "~/state/canvas";
import { useDebouncedValue } from "~/state/queries";
import { formatRelativeTimeLabel } from "~/timestampFormat";

/**
 * Picks one of a project's designs to open in the right panel.
 *
 * A design has no path a user can click, so this is how the surface is reached: the panel launcher
 * and its add-surface menu both open this, and it is the only place a design is chosen by name. The
 * list is ids and titles only — a design is opaque to DAK — so picking one still costs a render.
 *
 * The dialog re-reads the list every time it opens. An agent may have created a design since the
 * list was last read, and a stale picker reads as the agent's work having vanished.
 */

/** Long enough that typing a title does not search per keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 150;

/** Marks the focusable rows, so arrow keys move real focus instead of a highlight we would redraw. */
const ROW_ATTRIBUTE = "data-canvas-design-row";

const MODULE_LABELS: Record<CanvasDocumentSummary["module"], string> = {
  generic: "Design",
  deck: "Deck",
  web: "Web",
  mobile: "Mobile",
};

export function CanvasDesignPicker({
  open,
  onOpenChange,
  threadRef,
  projectId,
  projectName,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly projectName: string;
}) {
  const [query, setQuery] = useState("");
  const settledQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS).trim();
  const environmentId = threadRef.environmentId;

  // Nothing is asked for while the dialog is closed, so a closed picker holds no designs and no
  // subscription to a design that may never be opened.
  const target = useMemo(
    () =>
      open
        ? {
            environmentId,
            projectId,
            ...(settledQuery === "" ? {} : { query: settledQuery }),
          }
        : null,
    [open, environmentId, projectId, settledQuery],
  );
  const { designs, isPending, error, refresh } = useCanvasList(target);

  /**
   * Closing clears the search, so opening the dialog always shows the whole list rather than the
   * last thing that was typed. Done on the event instead of in an effect because it is a reaction to
   * the user, not a sync with an external system.
   */
  const closePicker = useCallback(() => {
    setQuery("");
    onOpenChange(false);
  }, [onOpenChange]);

  const openDesign = useCallback(
    (design: CanvasDocumentSummary) => {
      useRightPanelStore.getState().openCanvas(threadRef, {
        projectId,
        documentId: design.id,
        title: design.title,
      });
      closePicker();
    },
    [closePicker, projectId, threadRef],
  );

  // An effect event so the refresh runs when the dialog opens and not again when the query changes
  // the atom underneath it, which would spend a second read per keystroke.
  const refreshList = useEffectEvent(refresh);
  useEffect(() => {
    if (open) refreshList();
  }, [open]);

  /**
   * Arrow keys move real focus between rows rather than tracking a highlight of our own, so the
   * focus ring the design system already draws is what the user sees and what a screen reader
   * follows. Enter then activates the row because it is an ordinary button.
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const moveFocus = useCallback((direction: 1 | -1) => {
    const rows = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(`[${ROW_ATTRIBUTE}]`) ?? [],
    );
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row === document.activeElement);
    // Nothing focused yet starts at the first row; otherwise wrap around the ends.
    const next =
      current === -1
        ? direction === 1
          ? 0
          : rows.length - 1
        : (current + direction + rows.length) % rows.length;
    rows[next]?.focus();
  }, []);

  const searching = isPending && settledQuery !== "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else closePicker();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Open a design</DialogTitle>
          <DialogDescription>
            Designs in {projectName}. Ask the agent to change one, or to make a new one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
          ref={panelRef}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search designs"
                  aria-label="Search designs"
                />
              </div>
              {/* The slot is always present, so a search starting or finishing never shifts the field. */}
              <span className="grid size-4 shrink-0 place-items-center">
                {searching ? <Spinner size="xs" /> : null}
              </span>
            </div>
            {error !== null ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : designs.length === 0 ? (
              <Empty>
                <EmptyTitle>
                  {settledQuery === ""
                    ? `No designs in ${projectName} yet`
                    : `No designs match “${settledQuery}”`}
                </EmptyTitle>
                <EmptyDescription>
                  {settledQuery === ""
                    ? "Ask the agent to create one — “design a landing page for this project”."
                    : "Try a different search, or clear it to see every design."}
                </EmptyDescription>
              </Empty>
            ) : (
              <DiscoveryList>
                {designs.map((design, index) => (
                  <DiscoveryListRow
                    key={design.id}
                    {...{ [ROW_ATTRIBUTE]: String(index) }}
                    icon={
                      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                        <Frame className="size-4" />
                      </span>
                    }
                    title={design.title}
                    description={`Updated ${formatRelativeTimeLabel(design.updatedAt) || "recently"}`}
                    onClick={() => openDesign(design)}
                    action={
                      <span className="shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground">
                        {MODULE_LABELS[design.module]}
                      </span>
                    }
                  />
                ))}
              </DiscoveryList>
            )}
            <p className="text-xs text-muted-foreground">
              Designs live in this project&rsquo;s folder, so they are versioned with your code.
            </p>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
