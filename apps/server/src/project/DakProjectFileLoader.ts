/**
 * DakProjectFileLoader - Effect service that loads the checked-in `dak.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module DakProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DAK_PROJECT_FILE_NAME, type DakProjectFile } from "@dak/contracts";
import { DakProjectFileFromJson } from "@dak/shared/dakProjectFile";

const decodeDakProjectFileJson = Schema.decodeEffect(DakProjectFileFromJson);

export class DakProjectFileLoadError extends Schema.TaggedError<DakProjectFileLoadError>()(
  "DakProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${DAK_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for dak.json project file loading. */
export class DakProjectFileLoader extends Context.Service<
  DakProjectFileLoader,
  {
    /**
     * Load and decode `dak.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<DakProjectFile>>;
  }
>()("dak/project/DakProjectFileLoader") {}

const logDakProjectFileLoadError = (error: DakProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: DakProjectFileLoader["Service"]["load"] = Effect.fn("DakProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, DAK_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logDakProjectFileLoadError(
                  new DakProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<DakProjectFile>();
      }
      return yield* decodeDakProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logDakProjectFileLoadError(
              new DakProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<DakProjectFile>())),
        }),
      );
    },
  );

  return DakProjectFileLoader.of({ load });
});

export const layer = Layer.effect(DakProjectFileLoader, make);
