import type { ProjectId } from "@dak/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CanvasEngine, CanvasStore } from "./CanvasPorts.ts";
import * as CanvasEngineLive from "./CanvasEngineLive.ts";
import * as CanvasChangeBus from "./CanvasChangeBus.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStoreLive from "./CanvasStoreLive.ts";
import * as CanvasViewService from "./CanvasViewService.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * Canvas is per-project: a design is a directory under that project's workspace, and an export may
 * only write inside it. Neither the MCP server nor the WebSocket transport registers per project —
 * both serve the whole environment — so the target project is resolved per call and the store is
 * built for that project's root. This is the one place that does it, so the two transports cannot
 * drift on where a design lives or what it is allowed to write.
 */

/**
 * The engine is stateless — every call hydrates from the payload the store read and destroys its
 * models afterwards — so one instance serves every project. Building it per call would re-load
 * CanvasKit and QuickJS for nothing.
 */
const engine = CanvasEngineLive.make();

/**
 * The error a caller gets when a project cannot be resolved. It is left abstract so each transport
 * raises it in its own vocabulary: MCP refuses with `OrchestratorMcpFailure`, the socket with a
 * `CanvasViewError`, rather than one leaking the other's shape.
 */
export class CanvasProjectNotFound extends Error {
  readonly projectId: ProjectId;
  constructor(projectId: ProjectId) {
    super(`Canvas project ${projectId} was not found.`);
    this.name = "CanvasProjectNotFound";
    this.projectId = projectId;
  }
}

export interface CanvasProjectServices {
  readonly service: CanvasService.CanvasService["Service"];
  readonly view: CanvasViewService.CanvasViewService["Service"];
  readonly workspaceRoot: string;
  /**
   * The raw store and engine.
   *
   * Exposed because a caller that needs to render or measure directly — a screenshot, a tile — must
   * go through the same store and the same stateless engine rather than building its own, or the
   * panel, a screenshot and an export stop being three views of one document.
   */
  readonly store: CanvasStore;
  readonly engine: CanvasEngine;
}

/**
 * Builds both Canvas services for one project. `newOperationId` and `newClientUpdateId` are
 * required rather than defaulted because only the editing surface needs them, and minting ids for
 * a view that never edits would be work the caller did not ask for.
 */
export const servicesForProject = (
  projectId: ProjectId,
  newIds: {
    readonly newOperationId: () => string;
    readonly newClientUpdateId: () => string;
  },
): Effect.Effect<
  CanvasProjectServices,
  CanvasProjectNotFound,
  ProjectService.ProjectService | CanvasChangeBus.CanvasChangeBus
> =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const bus = yield* CanvasChangeBus.CanvasChangeBus;
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError((): CanvasProjectNotFound => new CanvasProjectNotFound(projectId)));
    if (Option.isNone(project)) {
      return yield* Effect.fail(new CanvasProjectNotFound(projectId));
    }
    const workspaceRoot = project.value.workspaceRoot;
    // The store's publish callback is synchronous and its write path has already returned, so the
    // announcement is run against the bus's own context rather than returned as an Effect the
    // store would have to await. Publishing is non-blocking and cannot fail.
    const publish = Effect.runSyncWith(Context.make(CanvasChangeBus.CanvasChangeBus, bus));
    const store = CanvasStoreLive.make({
      workspaceRoot,
      publish: (change) => {
        // The store is built per project and knows nothing of one; the bus serves the whole
        // environment and needs the project to attribute a design to it. This is where the two
        // facts meet, so it is the only place that has to add one to the other.
        publish(bus.publish({ projectId, ...change }));
      },
    });
    return {
      service: CanvasService.make({
        store,
        engine,
        // Storage and exports never leave the project the design belongs to.
        workspaceRoot,
        ...newIds,
      }),
      view: CanvasViewService.make({ store, engine }),
      workspaceRoot,
      store,
      engine,
    };
  });

/** The read-only pair, for a caller that renders or watches but never edits. */
export const viewServicesForProject = (
  projectId: ProjectId,
): Effect.Effect<
  CanvasProjectServices,
  CanvasProjectNotFound,
  ProjectService.ProjectService | CanvasChangeBus.CanvasChangeBus
> =>
  servicesForProject(projectId, {
    newOperationId: () => "",
    newClientUpdateId: () => "",
  });
