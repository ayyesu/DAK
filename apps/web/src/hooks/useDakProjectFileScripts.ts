import {
  DAK_PROJECT_FILE_NAME,
  type EnvironmentId,
  type DakProjectFile,
  type DakProjectFileScript,
} from "@dak/contracts";
import { parseDakProjectFile } from "@dak/shared/dakProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<DakProjectFileScript> = [];

export interface DakProjectFileState {
  /**
   * - `valid`: dak.json exists and decoded.
   * - `invalid`: dak.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable dak.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: DakProjectFile | null;
  scripts: ReadonlyArray<DakProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `dak.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useDakProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): DakProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", DAK_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseDakProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `dak.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useDakProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<DakProjectFileScript> {
  return useDakProjectFileState(environmentId, cwd).scripts;
}
