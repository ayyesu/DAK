# Canvas progress

The milestone list for the design surface, with the state of each. One line of evidence per row, and
the commit that produced it. If this file is being read after a context reset: start at the first row
that is not `done`, and do not redo anything above it.

Gates marked 🛑 are the user's and block everything below them.

## Milestones

| #   | Milestone                                                                        | Status      | Commit     | Evidence                                                                                                                                    |
| --- | -------------------------------------------------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Integrity: 5 acceptance tests, no placeholders, font test asserts `unknown_font` | **done**    | `2aec4b77` | 5 tests present; unshipped font measured against Inter before the fix, now throws `CANVAS_UNKNOWN_FONT` naming family + available + nearest |
| M1  | `dak_canvas_screenshot` registered via its own `addTool`                         | **blocked** | —          | planner + tool + scratch writer written and tested; MCP registration does not compile, see Blockers                                         |
| M2  | `dak_canvas_inspect` with measured boxes and stable codes                        | todo        |            |                                                                                                                                             |
| M3  | Edit feedback: issueSummary, measured boxes, delta; `dak_canvas_measure`         | todo        |            |                                                                                                                                             |
| M4  | Fonts: OFL families, per-family budget, `unknown_font` lists matches             | todo        |            |                                                                                                                                             |
| M5  | Design intelligence: script prelude helpers, design skill, rename/focus          | todo        |            |                                                                                                                                             |
| M6  | Design list: rename, trash, delete, thumbnails, search, duplicate                | todo        |            |                                                                                                                                             |
| M7  | Viewer S1+S2: world layout, navigation, title overlays                           | todo        |            |                                                                                                                                             |
| 🛑  | **G1** Playwright screenshots of the viewer's feel                               | todo        |            | user reviews                                                                                                                                |
| M8  | Viewer S3: tiles, dirty-rect invalidation, seam test                             | todo        |            |                                                                                                                                             |
| M9  | Viewer S4: selection and chat context                                            | todo        |            |                                                                                                                                             |
| M10 | Tier 1: follow the agent, issue badges, frame size menu, undo                    | todo        |            |                                                                                                                                             |
| 🛑  | **G2** user runs a real design session                                           | todo        |            | user reviews                                                                                                                                |
| M11 | 1e: live round trip, blind test, transcripts                                     | todo        |            | paused until user says go                                                                                                                   |
| 🛑  | **G3** 1e review                                                                 | todo        |            | user reviews                                                                                                                                |
| M12 | Tier 2/3: history scrub, inspector, export UI, rulers, grid, minimap, comments   | todo        |            | cut from the bottom                                                                                                                         |

## Order

- `M0 → M1 → M2 → M3` strictly ordered.
- `M4`, `M5`, `M6` may run in parallel after M3.
- `M7 → M8 → M9 → M10` strictly ordered; M8 cannot start before G1.
- If scope shrinks, cut from M12 upward, then M10's non-essentials. Never cut M2, M3 or M5.

## Definition of done

`inspect` clean on an agent-built landing page; the agent sees its own screenshots and corrects
itself; the viewer holds fixed frame sizes with pan, zoom and selection; designs can be renamed and
deleted. Every row above is `done` or carries a recorded blocker.

## Blockers

### M1 — MCP registration does not compile

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
