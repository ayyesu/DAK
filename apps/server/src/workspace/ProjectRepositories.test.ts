import { MAX_PROJECT_ADDED_FOLDERS } from "@dak/contracts";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ProjectRepositories from "./ProjectRepositories.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(ProjectRepositories.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodePath.layer),
);

const withTemp = <A, E>(
  body: (
    root: string,
  ) => Effect.Effect<
    A,
    E,
    ProjectRepositories.ProjectRepositories | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "dak-project-repositories-",
    });
    return yield* body(root);
  }).pipe(Effect.scoped, Effect.provide(layerTest));

const makeDirectory = (root: string, ...segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(root, ...segments);
    yield* fileSystem.makeDirectory(target, { recursive: true });
    return target;
  });

const makeGitDirectory = (root: string, ...segments: ReadonlyArray<string>) =>
  makeDirectory(root, ...segments, ".git");

const writeFile = (root: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFileString(target, contents);
  });

const list = (input: Parameters<ProjectRepositories.ProjectRepositories["Service"]["list"]>[0]) =>
  Effect.gen(function* () {
    const service = yield* ProjectRepositories.ProjectRepositories;
    return yield* service.list(input);
  });

it.effect("discovers direct and nested git repositories in a plain folder", () =>
  withTemp((root) =>
    Effect.gen(function* () {
      yield* makeGitDirectory(root, "api");
      yield* makeGitDirectory(root, "web");
      yield* makeGitDirectory(root, "services", "api");
      yield* makeDirectory(root, "node_modules", "dep");
      yield* makeDirectory(root, ".hidden");

      const result = yield* list({ workspaceRoot: root });

      expect(result.codeWorkspaceFile).toBeNull();
      expect(result.repositories).toEqual([
        { path: "api", name: "api", kind: "git", source: "discovered" },
        { path: "services/api", name: "api", kind: "git", source: "discovered" },
        { path: "web", name: "web", kind: "git", source: "discovered" },
      ]);
    }),
  ),
);

it.effect("lists the project root first when it is itself a repository", () =>
  withTemp((root) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* makeGitDirectory(root);
      yield* makeGitDirectory(root, "packages", "app");

      const result = yield* list({ workspaceRoot: root });

      expect(result.repositories).toEqual([
        { path: ".", name: path.basename(root), kind: "git", source: "discovered" },
        { path: "packages/app", name: "app", kind: "git", source: "discovered" },
      ]);
    }),
  ),
);

it.effect("reads workspace folders with comments, trailing commas, and long names", () =>
  withTemp((root) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "dak-project-repositories-outside-",
      });
      const outsideRepo = path.join(outside, "external-repo");
      yield* makeGitDirectory(root, "apps", "web");
      yield* makeGitDirectory(outside, "external-repo");
      yield* makeDirectory(root, "plain-folder");
      const relativeOutside = path.relative(root, outsideRepo).split(path.sep).join("/");
      const longName = "x".repeat(200);
      const contents = [
        "{",
        "  // the first folder is already discovered",
        '  "folders": [',
        '    { "path": ".", },',
        '    { "path": "apps/web", },',
        `    { "path": ${JSON.stringify(relativeOutside)}, "name": "External repo", },`,
        '    { "path": "missing-folder", "name": "Missing", }, /* trailing comment */',
        `    { "path": "plain-folder", "name": ${JSON.stringify(longName)}, },`,
        "  ],",
        "}",
      ].join("\n");
      yield* writeFile(root, "workspace.code-workspace", contents);

      const result = yield* list({ workspaceRoot: root });

      expect(result.codeWorkspaceFile).toBe("workspace.code-workspace");
      expect(result.repositories).toEqual([
        { path: "apps/web", name: "web", kind: "git", source: "discovered" },
        {
          path: outsideRepo,
          name: "External repo",
          kind: "git",
          source: "workspace",
        },
        {
          path: "missing-folder",
          name: "Missing",
          kind: "missing",
          source: "workspace",
        },
        {
          path: "plain-folder",
          name: longName.slice(0, 128),
          kind: "plain",
          source: "workspace",
        },
      ]);
    }),
  ),
);

it.effect("excludes submodule paths from ordinary discovery and lists them with parents", () =>
  withTemp((root) =>
    Effect.gen(function* () {
      yield* makeGitDirectory(root, "lib", "core");
      yield* makeDirectory(root, "vendor", "lib");
      yield* writeFile(
        root,
        ".gitmodules",
        [
          '[submodule "vendor/lib"]',
          "\tpath = vendor/lib # comment after the value",
          "\turl = https://example.com/lib.git",
        ].join("\n"),
      );
      yield* writeFile(root, "vendor/lib/.git", "gitdir: ../.git/modules/vendor/lib\n");
      yield* makeGitDirectory(root, "lib", "core", "third", "dep");
      yield* writeFile(
        root,
        "lib/core/.gitmodules",
        '[submodule "dep"]\n\tpath = "third/dep"\n\turl = https://example.com/dep.git\n',
      );

      const result = yield* list({ workspaceRoot: root });

      expect(result.repositories).toEqual([
        { path: "lib/core", name: "core", kind: "git", source: "discovered" },
        {
          path: "lib/core/third/dep",
          name: "dep",
          kind: "submodule",
          source: "discovered",
          parentPath: "lib/core",
        },
        {
          path: "vendor/lib",
          name: "lib",
          kind: "submodule",
          source: "discovered",
          parentPath: ".",
        },
      ]);
    }),
  ),
);

it.effect("skips worktree .git files with either separator", () =>
  withTemp((root) =>
    Effect.gen(function* () {
      yield* makeDirectory(root, "windows-worktree");
      yield* writeFile(
        root,
        "windows-worktree/.git",
        "gitdir: C:\\source\\main\\.git\\worktrees\\windows-worktree\n",
      );
      yield* makeDirectory(root, "posix-worktree");
      yield* writeFile(
        root,
        "posix-worktree/.git",
        "gitdir: /source/main/.git/worktrees/posix-worktree\n",
      );
      yield* makeGitDirectory(root, "keep");

      const result = yield* list({ workspaceRoot: root });

      expect(result.repositories).toEqual([
        { path: "keep", name: "keep", kind: "git", source: "discovered" },
      ]);
    }),
  ),
);

it.effect("keeps added folders when discovered folders exceed the cap", () =>
  withTemp((root) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from(
          { length: MAX_PROJECT_ADDED_FOLDERS + 2 },
          (_, index) => `repo-${String(index).padStart(3, "0")}`,
        ),
        (name) => makeGitDirectory(root, name),
        { concurrency: 16, discard: true },
      );
      yield* makeDirectory(root, "added");

      const result = yield* list({
        workspaceRoot: root,
        addedFolders: [
          { path: "added", name: "Added" },
          { path: "added", name: "Duplicate" },
        ],
      });

      expect(result.repositories).toHaveLength(MAX_PROJECT_ADDED_FOLDERS);
      expect(result.repositories[0]).toEqual({
        path: "repo-000",
        name: "repo-000",
        kind: "git",
        source: "discovered",
      });
      expect(result.repositories).toContainEqual({
        path: "added",
        name: "Added",
        kind: "plain",
        source: "added",
      });
      expect(result.repositories.some((repo) => repo.path === "repo-127")).toBe(false);
    }),
  ),
);
