import * as NodePath from "@effect/platform-node/NodePath";

import { MAX_PROJECT_ADDED_FOLDERS } from "@dak/contracts";
import type {
  ProjectAddedFolder,
  ProjectListRepositoriesResult,
  ProjectRepository,
} from "@dak/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

const MAX_SUBMODULES = 32;
const MAX_WORKSPACE_FOLDER_NAME_LENGTH = 128;

export class ProjectRepositoriesError extends Data.TaggedError("ProjectRepositoriesError")<{
  readonly operation: string;
  readonly path?: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.path === undefined
      ? `Project repositories operation '${this.operation}' failed.`
      : `Project repositories operation '${this.operation}' failed at '${this.path}'.`;
  }
}

export interface ProjectRepositoriesInput {
  readonly workspaceRoot: string;
  readonly addedFolders?: ReadonlyArray<ProjectAddedFolder>;
}

export class ProjectRepositories extends Context.Service<
  ProjectRepositories,
  {
    readonly list: (
      input: ProjectRepositoriesInput,
    ) => Effect.Effect<ProjectListRepositoriesResult, ProjectRepositoriesError>;
  }
>()("dak/workspace/ProjectRepositories") {}

interface DirectoryCandidate {
  readonly path: string;
  readonly absolutePath: string;
  readonly realPath: string;
  readonly name: string;
}

interface SubmoduleTarget {
  readonly path: string;
  readonly absolutePath: string;
  readonly realPath: string;
  readonly parentPath: string;
}

interface WorkspaceFolder {
  readonly path: string;
  readonly name?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isInsideRoot = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const normalizeRelativePath = (path: Path.Path, relativePath: string): string =>
  path.normalize(relativePath).split(path.sep).join("/");

const displayPath = (path: Path.Path, root: string, absolutePath: string): string => {
  const relative = path.relative(root, absolutePath);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return normalizeRelativePath(path, relative);
};

const basenameOf = (path: Path.Path, value: string): string => {
  const base = path.basename(value);
  return base.length > 0 ? base : value;
};

const isSkippableCause = (cause: unknown): boolean => {
  if (PlatformError.isPlatformError(cause)) {
    return cause.reason._tag === "NotFound" || cause.reason._tag === "PermissionDenied";
  }
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "EACCES";
  }
  return false;
};

const skipOnMissing = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  operation: string,
  path: string,
): Effect.Effect<A | undefined, ProjectRepositoriesError, R> =>
  effect.pipe(
    Effect.catch((cause) =>
      isSkippableCause(cause)
        ? Effect.succeed(undefined)
        : Effect.fail(
            new ProjectRepositoriesError({
              operation,
              path,
              cause,
            }),
          ),
    ),
  );

const guard = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  operation: string,
  path: string,
): Effect.Effect<A, ProjectRepositoriesError, R> =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new ProjectRepositoriesError({
          operation,
          path,
          cause,
        }),
    ),
  );

const comparePaths = (left: ProjectRepository, right: ProjectRepository): number => {
  if (left.path === "." && right.path !== ".") return -1;
  if (right.path === "." && left.path !== ".") return 1;
  return left.path.localeCompare(right.path);
};

const isGitdirLineWorktree = (contents: string): boolean => {
  const normalized = contents.replace(/\\/g, "/");
  return /^\s*gitdir\s*:/im.test(normalized) && normalized.includes("/worktrees/");
};

const stripJsonNoise = (input: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;
  let index = 0;

  while (index < input.length) {
    const current = input[index]!;
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      index += 1;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      index += 1;
      continue;
    }
    if (current === "/" && input[index + 1] === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && input[index + 1] === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        index += 1;
      }
      if (index < input.length) index += 2;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      let next: string | undefined;
      while (lookahead < input.length) {
        const candidate = input[lookahead]!;
        if (/\s/.test(candidate)) {
          lookahead += 1;
          continue;
        }
        if (candidate === "/" && input[lookahead + 1] === "/") {
          lookahead += 2;
          while (lookahead < input.length && input[lookahead] !== "\n") lookahead += 1;
          continue;
        }
        if (candidate === "/" && input[lookahead + 1] === "*") {
          lookahead += 2;
          while (
            lookahead < input.length &&
            !(input[lookahead] === "*" && input[lookahead + 1] === "/")
          ) {
            lookahead += 1;
          }
          lookahead += 2;
          continue;
        }
        next = candidate;
        break;
      }
      if (next === "}" || next === "]") {
        index += 1;
        continue;
      }
    }
    output += current;
    index += 1;
  }
  return output;
};

const parseWorkspaceFolders = (
  path: Path.Path,
  contents: string,
): ReadonlyArray<WorkspaceFolder> => {
  const value: unknown = JSON.parse(stripJsonNoise(contents));
  if (!isRecord(value) || !Array.isArray(value.folders)) return [];
  return value.folders.flatMap((folder): ReadonlyArray<WorkspaceFolder> => {
    if (!isRecord(folder) || typeof folder.path !== "string") return [];
    const folderPath = folder.path.trim();
    if (folderPath.length === 0 || path.normalize(folderPath) === ".") return [];
    return [
      typeof folder.name === "string" && folder.name.trim().length > 0
        ? { path: folderPath, name: folder.name.trim() }
        : { path: folderPath },
    ];
  });
};

const stripGitmodulesComment = (line: string): string => {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const current = line[index]!;
    if (quote !== undefined) {
      if (current === quote) quote = undefined;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }
    if (current === "#" || current === ";") return line.slice(0, index);
  }
  return line;
};

const unquoteGitmodulesValue = (value: string): string => {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).trim();
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
};

const parseGitmodulePaths = (contents: string): ReadonlyArray<string> =>
  contents.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*path\s*=\s*(.*)$/i.exec(stripGitmodulesComment(line));
    if (match === null) return [];
    const value = unquoteGitmodulesValue(match[1] ?? "");
    return value.length > 0 && value !== "." ? [value] : [];
  });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path.pipe(Effect.provide(NodePath.layer));

  const resolveRealPath = (absolutePath: string) =>
    Effect.gen(function* () {
      const resolved = path.resolve(absolutePath);
      const real = yield* fileSystem.realPath(resolved).pipe(Effect.option);
      return Option.getOrElse(real, () => resolved);
    });

  const readGitFileWorktree = (gitPath: string) =>
    Effect.gen(function* () {
      const gitInfo = yield* skipOnMissing(fileSystem.stat(gitPath), "stat", gitPath);
      if (gitInfo === undefined || gitInfo.type !== "File") return false;
      const contents = yield* skipOnMissing(
        fileSystem.readFileString(gitPath),
        "read-file",
        gitPath,
      );
      return contents !== undefined && isGitdirLineWorktree(contents);
    });

  const classifyFolder = (
    absolutePath: string,
  ): Effect.Effect<ProjectRepository["kind"], ProjectRepositoriesError> =>
    Effect.gen(function* () {
      const info = yield* skipOnMissing(fileSystem.stat(absolutePath), "stat", absolutePath);
      if (info === undefined) return "missing";
      if (info.type !== "Directory") return "plain";
      const gitPath = path.join(absolutePath, ".git");
      const gitInfo = yield* skipOnMissing(fileSystem.stat(gitPath), "stat", gitPath);
      if (gitInfo === undefined) return "plain";
      if (gitInfo.type === "File" && (yield* readGitFileWorktree(gitPath))) return "plain";
      return "git";
    });

  const isRepository = (absolutePath: string, rootRealPath: string) =>
    Effect.gen(function* () {
      const info = yield* skipOnMissing(fileSystem.stat(absolutePath), "stat", absolutePath);
      if (info === undefined || info.type !== "Directory") return false;
      const realPath = yield* resolveRealPath(absolutePath);
      if (!isInsideRoot(path, rootRealPath, realPath)) return false;
      const gitPath = path.join(absolutePath, ".git");
      const gitInfo = yield* skipOnMissing(fileSystem.stat(gitPath), "stat", gitPath);
      if (gitInfo === undefined) return false;
      if (gitInfo.type === "File" && (yield* readGitFileWorktree(gitPath))) return false;
      return true;
    });

  const readDirectory = (directory: string) =>
    skipOnMissing(fileSystem.readDirectory(directory), "read-directory", directory).pipe(
      Effect.map((entries) => entries ?? []),
    );

  const findCodeWorkspaceFile = (entries: ReadonlyArray<string>, root: string) =>
    Effect.forEach(
      entries
        .filter((entry) => entry.endsWith(".code-workspace"))
        .slice()
        .sort((left, right) => left.localeCompare(right)),
      (entry) =>
        Effect.gen(function* () {
          const absolutePath = path.join(root, entry);
          const info = yield* skipOnMissing(fileSystem.stat(absolutePath), "stat", absolutePath);
          return info?.type === "File" ? entry : undefined;
        }),
      { concurrency: 4 },
    ).pipe(Effect.map((results) => results.find((result) => result !== undefined) ?? null));

  const discoverRepositories = (rootRealPath: string) =>
    Effect.gen(function* () {
      const candidates: Array<DirectoryCandidate> = [];
      if (yield* isRepository(rootRealPath, rootRealPath)) {
        candidates.push({
          path: ".",
          absolutePath: rootRealPath,
          realPath: rootRealPath,
          name: basenameOf(path, rootRealPath),
        });
      }

      const children = yield* readDirectory(rootRealPath);
      const directChildren = yield* Effect.forEach(
        children,
        (name) =>
          Effect.gen(function* () {
            if (name.startsWith(".") || name === "node_modules") return undefined;
            const absolutePath = path.join(rootRealPath, name);
            const info = yield* skipOnMissing(fileSystem.stat(absolutePath), "stat", absolutePath);
            if (info === undefined || info.type !== "Directory") return undefined;
            const realPath = yield* resolveRealPath(absolutePath);
            if (!isInsideRoot(path, rootRealPath, realPath)) return undefined;
            return { name, absolutePath, realPath };
          }),
        { concurrency: 16 },
      );

      const discovered = yield* Effect.forEach(
        directChildren.filter((child) => child !== undefined),
        (child) =>
          Effect.gen(function* () {
            if (yield* isRepository(child.absolutePath, rootRealPath)) {
              return [
                {
                  path: normalizeRelativePath(path, child.name),
                  absolutePath: child.absolutePath,
                  realPath: child.realPath,
                  name: child.name,
                },
              ];
            }
            const grandchildren = yield* readDirectory(child.absolutePath);
            const nested = yield* Effect.forEach(
              grandchildren,
              (name) =>
                Effect.gen(function* () {
                  if (name.startsWith(".") || name === "node_modules") return undefined;
                  const absolutePath = path.join(child.absolutePath, name);
                  const info = yield* skipOnMissing(
                    fileSystem.stat(absolutePath),
                    "stat",
                    absolutePath,
                  );
                  if (info === undefined || info.type !== "Directory") return undefined;
                  const realPath = yield* resolveRealPath(absolutePath);
                  if (!isInsideRoot(path, rootRealPath, realPath)) return undefined;
                  if (!(yield* isRepository(absolutePath, rootRealPath))) return undefined;
                  return {
                    path: normalizeRelativePath(path, `${child.name}/${name}`),
                    absolutePath,
                    realPath,
                    name,
                  };
                }),
              { concurrency: 16 },
            );
            return nested.filter(
              (candidate): candidate is DirectoryCandidate => candidate !== undefined,
            );
          }),
        { concurrency: 8 },
      );

      candidates.push(...discovered.flat());
      const uniqueCandidates: Array<DirectoryCandidate> = [];
      const seenRealPaths = new Set<string>();
      for (const candidate of candidates) {
        if (seenRealPaths.has(candidate.realPath)) continue;
        seenRealPaths.add(candidate.realPath);
        uniqueCandidates.push(candidate);
      }
      return uniqueCandidates;
    });

  const readSubmoduleTargets = (repositoryPath: string, repositoryAbsolutePath: string) =>
    Effect.gen(function* () {
      const gitmodulesPath = path.join(repositoryAbsolutePath, ".gitmodules");
      const contents = yield* skipOnMissing(
        fileSystem.readFileString(gitmodulesPath),
        "read-file",
        gitmodulesPath,
      );
      if (contents === undefined) return [];
      return parseGitmodulePaths(contents).flatMap((submodulePath) => {
        if (path.isAbsolute(submodulePath)) return [];
        const absolutePath = path.resolve(repositoryAbsolutePath, submodulePath);
        const relativePath = path.relative(repositoryAbsolutePath, absolutePath);
        if (
          relativePath === "" ||
          relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath)
        ) {
          return [];
        }
        const relativeRepoPath = normalizeRelativePath(
          path,
          repositoryPath === "." ? relativePath : path.join(repositoryPath, relativePath),
        );
        return [
          {
            path: relativeRepoPath,
            absolutePath,
            realPath: path.resolve(absolutePath),
            parentPath: repositoryPath,
          },
        ];
      });
    });

  const collectSubmodules = (rootRealPath: string, candidates: ReadonlyArray<DirectoryCandidate>) =>
    Effect.gen(function* () {
      const targets: Array<SubmoduleTarget> = [];
      const parsedRoots = new Set<string>();

      const parseFrom = (
        repositoryPath: string,
        repositoryAbsolutePath: string,
        identity: string,
      ) =>
        Effect.gen(function* () {
          if (parsedRoots.has(identity)) return;
          parsedRoots.add(identity);
          const found = yield* readSubmoduleTargets(repositoryPath, repositoryAbsolutePath);
          for (const target of found) {
            if (targets.length >= MAX_SUBMODULES) return;
            const realPath = yield* resolveRealPath(target.absolutePath);
            if (!isInsideRoot(path, rootRealPath, realPath)) continue;
            targets.push({ ...target, realPath });
          }
        });

      yield* parseFrom(".", rootRealPath, rootRealPath);
      for (const candidate of candidates) {
        if (targets.length >= MAX_SUBMODULES) break;
        if (candidate.path === ".") continue;
        yield* parseFrom(candidate.path, candidate.absolutePath, candidate.realPath);
      }
      return targets;
    });

  const list: ProjectRepositories["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rootRealPath = yield* guard(
        fileSystem.realPath(path.resolve(input.workspaceRoot)),
        "realpath-workspace-root",
        input.workspaceRoot,
      );
      const entries = yield* guard(
        fileSystem.readDirectory(rootRealPath),
        "read-directory",
        input.workspaceRoot,
      );
      const codeWorkspaceFile = yield* findCodeWorkspaceFile(entries, rootRealPath);

      const workspaceFolders: ReadonlyArray<WorkspaceFolder> =
        codeWorkspaceFile === null
          ? []
          : yield* Effect.gen(function* () {
              const codeWorkspacePath = path.join(rootRealPath, codeWorkspaceFile);
              const contents = yield* guard(
                fileSystem.readFileString(codeWorkspacePath),
                "read-file",
                codeWorkspaceFile,
              );
              return yield* Effect.try({
                try: () => parseWorkspaceFolders(path, contents),
                catch: (cause) =>
                  new ProjectRepositoriesError({
                    operation: "parse-code-workspace",
                    path: codeWorkspaceFile,
                    cause,
                  }),
              }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<WorkspaceFolder>)));
            });

      const candidates = yield* discoverRepositories(rootRealPath);
      const submoduleTargets = yield* collectSubmodules(rootRealPath, candidates);
      const excludedRealPaths = new Set(submoduleTargets.map((target) => target.realPath));
      const excludedPaths = new Set(submoduleTargets.map((target) => target.path));

      const discovered: Array<ProjectRepository> = candidates
        .filter(
          (candidate) =>
            !excludedRealPaths.has(candidate.realPath) && !excludedPaths.has(candidate.path),
        )
        .map((candidate) => ({
          path: candidate.path,
          name: candidate.name,
          kind: "git" as const,
          source: "discovered" as const,
        }));

      for (const target of submoduleTargets) {
        const gitPath = path.join(target.absolutePath, ".git");
        const gitInfo = yield* skipOnMissing(fileSystem.stat(gitPath), "stat", gitPath);
        if (gitInfo === undefined) continue;
        if (gitInfo.type === "File" && (yield* readGitFileWorktree(gitPath))) continue;
        discovered.push({
          path: target.path,
          name: basenameOf(path, target.path),
          kind: "submodule",
          source: "discovered",
          parentPath: target.parentPath,
        });
      }

      discovered.sort(comparePaths);

      const seenPaths = new Set<string>();
      for (const repository of discovered) {
        const absolutePath = path.resolve(rootRealPath, repository.path);
        seenPaths.add(yield* resolveRealPath(absolutePath));
      }

      const workspaceRepositories: Array<ProjectRepository> = [];
      for (const folder of workspaceFolders) {
        const absolutePath = path.resolve(rootRealPath, folder.path);
        const realPath = yield* resolveRealPath(absolutePath);
        if (seenPaths.has(realPath)) continue;
        seenPaths.add(realPath);
        const repositoryPath = displayPath(path, rootRealPath, absolutePath);
        const name =
          folder.name === undefined
            ? basenameOf(path, repositoryPath)
            : folder.name.slice(0, MAX_WORKSPACE_FOLDER_NAME_LENGTH);
        workspaceRepositories.push({
          path: repositoryPath,
          name,
          kind: yield* classifyFolder(absolutePath),
          source: "workspace",
        });
      }
      workspaceRepositories.sort(comparePaths);

      const addedRepositories: Array<ProjectRepository> = [];
      for (const folder of input.addedFolders ?? []) {
        const absolutePath = path.resolve(rootRealPath, folder.path);
        const realPath = yield* resolveRealPath(absolutePath);
        if (seenPaths.has(realPath)) continue;
        seenPaths.add(realPath);
        addedRepositories.push({
          path: displayPath(path, rootRealPath, absolutePath),
          name: folder.name,
          kind: yield* classifyFolder(absolutePath),
          source: "added",
        });
      }
      addedRepositories.sort(comparePaths);

      const recomputed = [...discovered, ...workspaceRepositories];
      const repositories =
        recomputed.length + addedRepositories.length <= MAX_PROJECT_ADDED_FOLDERS
          ? [...recomputed, ...addedRepositories]
          : [
              ...recomputed.slice(
                0,
                Math.max(0, MAX_PROJECT_ADDED_FOLDERS - addedRepositories.length),
              ),
              ...addedRepositories,
            ];

      return { repositories, codeWorkspaceFile };
    });

  return ProjectRepositories.of({ list });
});

export const layer = Layer.effect(ProjectRepositories, make);
