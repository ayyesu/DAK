import { createGitEnvironmentAtoms } from "@dak/client-runtime/state/git";

import { connectionAtomRuntime } from "../connection/runtime";

export const gitEnvironment = createGitEnvironmentAtoms(connectionAtomRuntime);
