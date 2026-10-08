import { createAttachmentEnvironmentAtoms } from "@dak/client-runtime/state/attachments";

import { connectionAtomRuntime } from "../connection/runtime";

export const attachmentEnvironment = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
