import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";

const tones = {
  muted: { label: "text-sidebar-muted-foreground/70", line: "bg-sidebar-border/60" },
  info: { label: "text-blue-600 dark:text-blue-400", line: "bg-blue-500/20 dark:bg-blue-400/15" },
  emphasized: { label: "text-sidebar-foreground/85", line: "bg-sidebar-foreground/25" },
  accent: { label: "text-primary", line: "bg-primary/50" },
} as const;

/** Callers own the section state and content; this owns all header geometry. */
export function CollapsibleSectionHeader({
  children,
  expanded,
  tone = "muted",
  accessory,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "style" | "aria-expanded"> & {
  expanded: boolean;
  tone?: keyof typeof tones;
  accessory?: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        // A native sidebar section header: small, muted, regular case, with the
        // chevron and a hairline doing the separating rather than a heavier
        // weight or letterspaced caps.
        "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-3xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        tones[tone].label,
      )}
    >
      <span className="shrink-0">{children}</span>
      <span aria-hidden className={cn("h-px min-w-2 flex-1", tones[tone].line)} />
      {accessory}
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
      />
    </button>
  );
}

export function SectionHeaderStatus({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-3xs leading-none text-destructive-foreground">{children}</span>
  );
}

/** How many rows a shelf holds, so a collapsed shelf still says how much it
 * is hiding. Neutral where SectionHeaderStatus is a warning. */
export function SectionHeaderCount({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-3xs leading-none tabular-nums opacity-70">{children}</span>;
}
