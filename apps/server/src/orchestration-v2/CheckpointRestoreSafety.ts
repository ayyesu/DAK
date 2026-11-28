import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@dak/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";

// A checkpoint snapshots the whole checkout. Check at command admission and
// again before provider rollback so a newly shared worktree is rejected too.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "worktreeRepositories">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd" | "additionalCwds">,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
      readonly projects: ProjectStore.ProjectStoreV2["Service"];
      readonly path: Path.Path;
    },
  ) {
    const { fileSystem, projections, projects, path } = dependencies;
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    const realPathOrNull = (candidate: string) =>
      fileSystem
        .realPath(candidate)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );

    const ownedPaths = [
      thread.worktreePath,
      ...(thread.worktreeRepositories ?? []).map((repository) => repository.worktreePath),
    ].filter((value): value is string => value !== null);
    const restoreCwds = [scope.cwd, ...(scope.additionalCwds ?? [])];
    let shared = thread.worktreePath == null || ownedPaths.length === 0;
    if (!shared) {
      const ownedRealPaths = new Set(
        (yield* Effect.forEach(ownedPaths, realPathOrNull, {
          concurrency: 1,
        })).filter((value): value is string => value !== null),
      );
      const resolvedRestoreCwds = (yield* Effect.forEach(restoreCwds, realPathOrNull, {
        concurrency: 1,
      })).filter((value): value is string => value !== null);
      shared =
        resolvedRestoreCwds.length === 0 ||
        resolvedRestoreCwds.some((cwd) => !ownedRealPaths.has(cwd));
      if (!shared) {
        const shell = yield* projections.getShellSnapshot();
        const checkedPaths = new Set<string>();
        for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
          if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
          const other = yield* projections.getCheckpointContext(otherThread.id);
          const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
          const paths = [
            otherThread.worktreePath,
            ...(otherThread.worktreeRepositories ?? []).map(
              (repository) => repository.worktreePath,
            ),
            ...other.checkpointScopes.flatMap((candidate) => [
              candidate.cwd,
              ...(candidate.additionalCwds ?? []),
            ]),
            // A failed turn can leave an errored session with a live event stream.
            // A session shared across threads keeps the cwd it was opened with,
            // often another thread's; each turn runs in the thread's own
            // worktree or project root, which this list already covers.
            ...providerContext.providerSessions
              .filter(
                (session) =>
                  session.status !== "stopped" &&
                  !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
              )
              .map((session) => session.cwd),
          ].filter((value): value is string => value !== null);
          if (otherThread.worktreePath === null) {
            // A thread without a worktree works in its project's checkout.
            const project = yield* projects.get(otherThread.projectId, { includeDeleted: true });
            if (Option.isNone(project)) return false;
            paths.push(project.value.workspaceRoot);
          }
          for (const candidate of paths) {
            if (checkedPaths.has(candidate)) continue;
            checkedPaths.add(candidate);
            const otherCwd = yield* realPathOrNull(candidate);
            if (
              otherCwd !== null &&
              resolvedRestoreCwds.some((cwd) => contains(cwd, otherCwd) || contains(otherCwd, cwd))
            ) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
      }
    }
    return !shared;
  },
);
