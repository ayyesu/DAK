import { lstat, link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeAtomicFile(destination, bytes) {
  assertAbsolute(destination); await assertMissing(destination);
  const directory = dirname(destination); await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(destination)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.close();
    // Linking publishes complete bytes atomically and fails if any destination
    // entry already exists, including a dangling symlink or a concurrent writer.
    await link(temporary, destination);
  } catch (error) {
    if (error.code === "EEXIST") error.code = "CANVAS_EXPORT_EXISTS";
    throw error;
  } finally { await handle.close(); await rm(temporary, { force: true }); }
  return destination;
}

export async function writeExclusiveBundle(destination, files) {
  const entries = [...files];
  const names = new Set();
  for (const [name] of entries) {
    validateRelativeFile(name);
    const normalized = name.normalize("NFC").toLowerCase();
    if (names.has(normalized)) throw new Error(`Export filename collision: ${name}.`);
    names.add(normalized);
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (names.has(parts.slice(0, index).join("/"))) throw new Error(`Export file/directory collision: ${name}.`);
    }
  }
  assertAbsolute(destination); await assertMissing(destination);
  const parent = dirname(destination); await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, `.${basename(destination)}.`));
  let reserved = false;
  const published = [];
  try {
    for (const [name, value] of entries) {
      const path = join(temporary, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value, { flag: "wx" });
    }
    // Node has no exclusive directory rename. Reserve the destination with
    // mkdir, then link complete staged files without replacement. The bundle
    // becomes visible incrementally, not atomically as a whole.
    await mkdir(destination);
    reserved = true;
    for (const [name] of entries) {
      const path = join(destination, name);
      await mkdir(dirname(path), { recursive: true });
      await link(join(temporary, name), path);
      published.push(path);
    }
  } catch (error) {
    if (reserved) {
      // Do not recursively remove a published directory: another actor may
      // already have placed unrelated data there. Report exactly what remains.
      error.code = "CANVAS_EXPORT_PARTIAL";
      error.destination = destination;
      error.artifacts = published;
      error.message = `Export failed after reserving ${destination}; ${published.length} complete artifact(s) remain. ${error.message}`;
    } else if (error.code === "EEXIST") error.code = "CANVAS_EXPORT_EXISTS";
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return destination;
}

export function validateOutputSegment(value) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || /[\/\\\0-\x1f]/u.test(value) || value === "." || value === ".." || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value) || new TextEncoder().encode(value).length > 255) throw new Error(`Unsafe output segment ${JSON.stringify(value)}.`);
  return value;
}
async function assertMissing(path) { try { await lstat(path); const error = new Error(`Destination already exists: ${path}.`); error.code = "CANVAS_EXPORT_EXISTS"; throw error; } catch (error) { if (error.code !== "ENOENT") throw error; } }
function assertAbsolute(path) { if (typeof path !== "string" || !path.startsWith("/")) throw new Error("Export destination must be an absolute path."); }
function validateRelativeFile(name) {
  if (name.startsWith("/")) throw new Error(`Unsafe bundle filename ${name}.`);
  for (const part of name.split("/")) validateOutputSegment(part);
}
