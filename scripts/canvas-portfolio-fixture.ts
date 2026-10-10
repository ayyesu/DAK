// Builds the test fixture from the real design, once, so the suite never reads a developer's disk.
//
// Run by hand after the real design changes; the committed JSON it writes is what the tests read.
//   node --experimental-strip-types scripts/canvas-portfolio-fixture.ts
import * as NodeFS from "node:fs";
import { pathToFileURL } from "node:url";

const imp = (p) => import(pathToFileURL(p).href);
const REPO = "C:/Users/ATTAH KUMAH MENSAH/Desktop/projects/DAK";
const SOURCE =
  process.argv[2] ??
  "C:/Users/ATTAH KUMAH MENSAH/Desktop/projects/portfolio/.dak/canvas/design-fd2533e6-1792-42fc-83a0-d71006d72fe8";
const TARGET = `${REPO}/apps/server/src/canvas/fixtures/portfolio-landing-page.json`;

const { restoreDocumentModel, materialize } = await imp(
  `${REPO}/packages/canvas-engine/upstream/src/document-model.mjs`,
);
const { withImplicitAbsoluteLayout } = await imp(
  `${REPO}/apps/server/src/canvas/canvasInvariants.ts`,
);

const snapshot = JSON.parse(NodeFS.readFileSync(`${SOURCE}/snapshot.json`, "utf8"));
const updates = NodeFS.readFileSync(`${SOURCE}/updates.jsonl`, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const model = restoreDocumentModel({
  snapshot: {
    throughSequence: snapshot.throughSequence,
    state: snapshot.state,
    source: snapshot.source,
  },
  updates,
});
// The stored projection is trimmed to what a test needs: the document itself, not the Yjs log, and
// only the ids and counters a test asserts on.
const document = withImplicitAbsoluteLayout(JSON.parse(JSON.stringify(materialize(model))));

const countNodes = (nodes) =>
  (nodes ?? []).reduce((total, node) => total + 1 + countNodes(node.children), 0);
const countText = (nodes) =>
  (nodes ?? []).reduce(
    (total, node) => total + (node.type === "text" ? 1 : 0) + countText(node.children),
    0,
  );

NodeFS.mkdirSync(`${REPO}/apps/server/src/canvas/fixtures`, { recursive: true });
NodeFS.writeFileSync(
  TARGET,
  `${JSON.stringify(
    {
      title: "Portfolio Landing Page",
      module: document.module,
      sequence: snapshot.throughSequence,
      frameId: document.children[0].id,
      nodeCount: countNodes(document.children),
      textCount: countText(document.children),
      document,
    },
    null,
    2,
  )}\n`,
);
model.doc.destroy();
console.log(
  `wrote ${TARGET}\n  nodes=${countNodes(document.children)} text=${countText(document.children)} ` +
    `frame=${document.children[0].width}x${document.children[0].height}`,
);
