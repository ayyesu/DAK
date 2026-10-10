import { createCanvasEnvironmentAtoms } from "@dak/client-runtime/state/canvas";
import type { CanvasListResult, EnvironmentId, ProjectId } from "@dak/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";

export const canvasEnvironment = createCanvasEnvironmentAtoms(connectionAtomRuntime);

/**
 * The list a picker reads. Rendering is not here: a design view drives its own render atom so it can
 * refresh it on exactly the sequences that moved, and a helper that hid the atom could not.
 */
export interface CanvasListTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly query?: string;
  readonly includeTrash?: boolean;
}

export function useCanvasList(target: CanvasListTarget | null): {
  readonly designs: CanvasListResult["items"];
  readonly isPending: boolean;
  readonly error: string | null;
  /**
   * Re-reads the list. A picker calls this on open: the agent may have created a design since the
   * list was last read, and a stale picker looks like the agent's work vanished.
   */
  readonly refresh: () => void;
} {
  const list = useEnvironmentQuery(
    useMemo(() => {
      if (target === null) return null;
      return canvasEnvironment.list({
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          ...(target.query === undefined ? {} : { query: target.query }),
          ...(target.includeTrash === undefined ? {} : { includeTrash: target.includeTrash }),
        },
      });
    }, [target?.environmentId, target?.projectId, target?.query, target?.includeTrash]),
  );
  const designs = useMemo(() => list.data?.items ?? [], [list.data]);
  return {
    designs,
    isPending: list.isPending,
    error: list.error,
    refresh: list.refresh,
  };
}
