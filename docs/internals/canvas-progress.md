# Canvas progress

The milestone list for the design surface, with the state of each. One line of evidence per row, and
the commit that produced it. If this file is being read after a context reset: start at the first row
that is not `done`, and do not redo anything above it.

Gates marked 🛑 are the user's and block everything below them.

## Milestones

| #   | Milestone                                                                        | Status   | Commit       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Integrity: 5 acceptance tests, no placeholders, font test asserts `unknown_font` | **done** | `2aec4b77`   | 5 tests present; unshipped font measured against Inter before the fix, now throws `CANVAS_UNKNOWN_FONT` naming family + available + nearest                                                                                                                                                                                                                                                                                      |
| M1a | `dak_canvas_screenshot` as an ordinary toolkit tool, answers with file paths     | **done** | `310f469e`   | 5 handler tests through `McpToolAccess`; PNG header read back off disk; frame at x=120 crops from its own origin; tall frame gives an overview plus gapless sections                                                                                                                                                                                                                                                             |
| M1b | Canvas toolkit registered on `/mcp` so the tools are reachable at all            | **done** | `bb85e186`   | 79 tools listed before, none named `dak_canvas_*`; assertion added to the `tools/list` HTTP test and confirmed to fail without the fix                                                                                                                                                                                                                                                                                           |
| M1c | Same screenshots also attached as MCP image blocks                               | **done** | `4b3ac86d`   | `registerImageTool` reads a `parts` array; single-`screenshot` tools untouched. Tall frame → 8 image blocks, cap note in text, no base64 in text                                                                                                                                                                                                                                                                                 |
| M1d | Whole-frame scale capped at 2x, sections paged via `nextSectionIndex`            | **done** | `0cfb3a73`   | 390x6000 went from 20 parts to 9 (2 pages). Also fixed the handler reporting pixel height as `height`, which made every section look 2x too tall                                                                                                                                                                                                                                                                                 |
| M2  | `dak_canvas_inspect` with measured boxes and stable codes                        | **done** | `ac78509e`   | 9 codes, contrast against nearest filled ancestor, overlap rule tested 7 ways; 182 canvas tests green                                                                                                                                                                                                                                                                                                                            |
| M3  | Edit feedback: issueSummary, measured boxes, delta; `dak_canvas_measure`         | **done** | `7cbace3d`   | delta test: breaking edit reports `frames_overlap` as introduced, the fixing edit reports it resolved, a no-op reports no delta; 184 canvas tests green                                                                                                                                                                                                                                                                          |
| M4  | Fonts: OFL families, per-family budget, `unknown_font` lists matches             | **done** | `249902ef`   | 7 shipped / 4 excluded / 0 missing, now enforced by `canvas:verify`. `unknown_font` behaviour landed in M0 (`2aec4b77`); per-family budget and coverage tests here                                                                                                                                                                                                                                                               |
| M4b | Type palette: serif + grotesk + condensed as static Latin TTFs, manifest-owned   | **done** | `bbb885cb`   | Playfair Display 400/700, Space Grotesk 400/500/700, Anton 400 (247 KB). Engine preloads bytes so the pinned screenshot map needs no edit; `unknown_font` lists all 5 families, `Playfair` suggests `Playfair Display`; specimen image shows 5 distinct faces; 780px legibility crop readable; font budget 2→6 MB (snapshot+owned), engine gzip/snapshot ceilings untouched                                                      |
| M5  | Design intelligence: script prelude helpers, design skill, rename/focus          | todo     |              |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M6  | Design list: rename, trash, delete, thumbnails, search, duplicate                | todo     |              |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M7  | Viewer S1+S2: world layout, navigation, title overlays                           | **done** | `14412524f9` | World layout as a row of design-size boxes under one camera transform; navigation by wheel, space-drag, +/-, a stepped zoom control and Fit; frame titles moved above the frame instead of over its artwork, counter-scaled and truncated to the frame's own width; the viewport carries a field so a frame reads as a board on a canvas. 56 web canvas tests, `apps/web` tsc clean, `canvas:verify` 26 files / 265 tests green. |     |
| 🛑  | **G1** Playwright screenshots of the viewer's feel                               | todo     |              | user reviews                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M8  | Viewer S3: tiles, dirty-rect invalidation, seam test                             | todo     |              |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M9  | Viewer S4: selection and chat context                                            | todo     |              |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M10 | Tier 1: follow the agent, issue badges, frame size menu, undo                    | todo     |              |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 🛑  | **G2** user runs a real design session                                           | todo     |              | user reviews                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M11 | 1e: live round trip, blind test, transcripts                                     | todo     |              | paused until user says go                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🛑  | **G3** 1e review                                                                 | todo     |              | user reviews                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M12 | Tier 2/3: history scrub, inspector, export UI, rulers, grid, minimap, comments   | todo     |              | cut from the bottom                                                                                                                                                                                                                                                                                                                                                                                                              |

## Order

- `M0 → M1 → M2 → M3` strictly ordered.
- `M4`, `M5`, `M6` may run in parallel after M3.
- `M7 → M8 → M9 → M10` strictly ordered; M8 cannot start before G1.
- If scope shrinks, cut from M12 upward, then M10's non-essentials. Never cut M2, M3 or M5.

**Corrected 2026-10-11:** M2, M3, M4 and M6 do **not** depend on M1. Inspect, measure, the edit
delta, the font set and the design list are all service- and toolkit-level work that reaches a model
as ordinary JSON, so M1's MCP image block is not on their path. M1 can be resumed at any point.

## Definition of done

`inspect` clean on an agent-built landing page; the agent sees its own screenshots and corrects
itself; the viewer holds fixed frame sizes with pan, zoom and selection; designs can be renamed and
deleted. Every row above is `done` or carries a recorded blocker.

## Blockers

### M1c — image blocks need a decision, not a copy

`registerImageTool` (`McpHttpServer.ts:633`) already does what M1c wants: register a tool by hand
and emit its PNG as an image block. It is the shared path behind `device_screenshot` and
`html_preview`, so M1c should reuse it rather than copy `preview_snapshot` again.

It does not fit the canvas answer as written. It destructures a single `screenshot` field off the
result and attaches exactly one image, whereas a tall frame returns an overview plus N section
crops in `parts`. Three ways out:

1. **Reuse `registerImageTool` with a stitched single image.** Attach only the overview. Simplest,
   but the overview is the low-resolution image; the sharp sections would never reach the model,
   which is the whole reason for the slicing.
2. **Generalise `registerImageTool` to a `parts` array.** Attach every part in order, JSON metadata
   without the base64. Touches a shared helper used by two other tools, so their tests must stay
   green.
3. **Write a canvas-specific registration** alongside `preview_snapshot`. No shared-helper risk,
   but it is a third copy of the same plumbing.

Recommendation is 2, because the base64-stripping and failure mapping are identical and a
per-canvas copy would be a third place to keep in step. Option 1 is wrong on its merits, not just
less capable: it would attach the one image the design explicitly produced to be too small to read.

Not yet started; needs a decision between these.

### Standing verification rule

Run `npm run canvas:verify` before **every** canvas commit. It runs the canvas suite, the
toolkit-wide `core.test.ts`, the HTTP registration test, the font coverage tests, and the font
coverage gate itself.

This exists because each of those passed on its own while the canvas toolkit was not in
`McpHttpServer.layer` at all (fixed in `bb85e186`), and because `core.test.ts` was already failing
on missing presentation definitions that a canvas-only run never saw. The gap was not a flaky test;
it was the verification scope. Run the three together, every time.

### Pre-existing failures, not ours

Recorded so they are not re-investigated at every boundary. Each was confirmed to fail identically
with this work's changes reverted.

- `packages/shared`: `otelEnvironment` (1), `threadPullRequests` (2), `git` (1), `nodeRuntime` (1).
  Confirmed by restoring the pre-`bb85e186` copy of the one changed `packages/shared` file
  (`dakMcpToolPresentation.ts`) and re-running: same 5 failures. None of those four test files or
  their subjects were touched by any commit here.
- `apps/server/src/mcp/McpHttpServer.test.ts` → `saves the snapshot PNG on request and reports its
path`. One line: a Windows path-escaping bug, where the assertion expects an unescaped `C:\...`
  path inside a JSON text block and the backslashes come back doubled. Confirmed to fail identically
  with the committed `McpHttpServer.ts` restored. Not fixed here — unrelated to Canvas, and a silent
  drive-by fix would hide it from whoever owns it.
- Lint: `CanvasRenderBudget.test.ts` (`dak(namespace-node-imports)`) and `CanvasViewService.test.ts`
  (7× `dak(no-manual-effect-runtime-in-tests)`). Pre-existing, in files this work does not touch.

### M1c — image blocks (decided and shipped)

Option 2 was chosen: generalise `registerImageTool` rather than copy `preview_snapshot` a third time.
Implemented as a superset — `parts` alongside `screenshot` — so `device_screenshot` and
`html_preview` needed no change and their tests were not edited.

Two things the implementation had to settle that were not obvious in advance:

- **The cap.** 8 images / 24MB, measured on the base64 that actually goes over the wire. A client
  that rejects an oversized result loses the text answer too, so trimming images is safer than
  risking the whole result. The trade is real: a very tall frame loses its later sections as images
  and must be opened from the paths instead. Every part is written to disk regardless, and the trim
  is stated in the text so the agent knows to look.
- **`includeImage` defaults to on** for this route, because the route exists to attach the image.
  The ordinary toolkit path passes `false`. A part with no bytes is skipped rather than decoded.

### M1 — MCP registration does not compile (historical)

Superseded by M1a and M1b. Recorded because the three failed attempts are why the registration was
avoided a second time, and why it was then missed entirely rather than re-attempted.

The screenshot tool's logic, planner and scratch writer are written, tested and typecheck-clean
(`canvasScreenshot.ts`, `canvasScreenshotTool.ts`, `canvasScreenshotScratch.ts`, `bytes.ts`, 10 tests).
What is missing is the `server.addTool` registration in `apps/server/src/mcp/McpHttpServer.ts`.

Three attempts, each reverted rather than left half-built:

1. Reused `imageToolRegistration`, which requires a `McpToolAccess.HandlersLayer`. The screenshot
   handler resolves services itself and has no handlers layer. 13 errors, including
   `Property '#layer' is missing in type 'Layer<never, never, never>' but required in type 'HandlersLayer<...>'`.
2. Handled services inside the registration effect via `Effect.context<...>()` + `provideServiceMap`.
   `provideServiceMap` does not exist in Effect 4 and `Effect.context` takes 0-1 type parameters.
   22 errors.
3. Switched to `Context.getUnsafe(fiber.context, ...)` inside `Effect.withFiber`, matching
   `preview_snapshot`. Type errors resolved, but a PowerShell `-replace` mangled a backtick template
   literal and left the file unparseable (`TS1005: ',' expected` ×5). Reverted.

Next attempt should use the `edit` tool for the whole handler rather than a shell `-replace`, since
every failure of attempts 1-3 was in the editing step or in borrowing `preview_snapshot`'s wrapper
rather than in the design. `Layer.effectDiscard(registerCanvasScreenshot())` is the right wrapper:
the handler provides its own services from the fiber, so the registration layer needs only
`McpServer.McpServer`.

## Notes

- The whole Canvas feature began as uncommitted work: ~30 untracked files across `apps/server`,
  `apps/web`, `packages/contracts` and `packages/client-runtime`, plus modifications to `ws.ts`,
  `rightPanelStore.ts`, `ChatView.tsx` and others. The first commit after M0 sweeps those in, because
  the server does not typecheck without them. This was a deliberate call, not an accident.
